/* ============================================================================
   B & B CONCRETE — "ASK THE COACH" AI PROXY (Cloudflare Worker)
   ----------------------------------------------------------------------------
   READY TO DEPLOY — no edits needed. The allowed website is already set to
   https://dburrone.github.io (your Coaching Corner GitHub Pages site).

   Deploys automatically from GitHub via Cloudflare "Import a repository."
   The AI binding is configured by wrangler.jsonc in this same repo.
============================================================================ */

const ALLOWED_ORIGINS = [
  "https://dburrone.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

/* Model choice:
   - "@cf/meta/llama-3.3-70b-instruct-fp8-fast"  -> best answers (default)
   - "@cf/meta/llama-3.1-8b-instruct"            -> uses far less of the free
     daily allowance; switch if you ever bump into the daily limit. */
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const MAX_QUESTION_CHARS = 600;
const MAX_CONTEXT_CHARS = 20000;
const MAX_ANSWER_TOKENS = 700;

/* Best-effort rate limiting: 8 questions per minute per IP address. */
const RATE = { windowMs: 60000, max: 8 };
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  if (arr.length >= RATE.max) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

const SYSTEM_PROMPT = `You are "the Coach," the SOP assistant for B & B Concrete Co., Inc.
(including Lafayette Ready Mix and Senter Transit Mix). You help dispatchers,
plant operators, mixer truck operators (MTOs), and loader operators find and
follow company Standard Operating Procedures.

RULES — follow all of them:
1. Answer ONLY from the SOP excerpts provided in the user message. Never
   invent procedures, numbers, tolerances, or phone numbers.
2. Cite your sources inline, e.g. "per SOP 12 — Taking the Order."
3. If the excerpts do not cover the question, say so plainly and tell the
   person to contact their supervisor or the support center at 662.842.6312.
   Do not guess.
4. Keep answers short and field-ready: numbered steps for procedures, a
   sentence or two for simple questions. Plain language, no fluff.
5. Safety always comes first. If a question touches safety, lead with the
   safety requirement (PPE, lockout, three points of contact, etc.) exactly
   as the SOPs state it.
6. Never contradict an SOP, and never advise skipping a step.`;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, origin);
    }
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "Origin not allowed" }, 403, origin);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (rateLimited(ip)) {
      return json({ error: "Too many questions — wait a minute." }, 429, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad request body" }, 400, origin);
    }

    const question = String(body.question || "").trim().slice(0, MAX_QUESTION_CHARS);
    const context = String(body.context || "").slice(0, MAX_CONTEXT_CHARS);
    if (!question) return json({ error: "Empty question" }, 400, origin);

    const userMsg =
      (context
        ? "SOP EXCERPTS (your only source of truth):\n" + context + "\n\n"
        : "NO MATCHING SOP EXCERPTS WERE FOUND for this question.\n\n") +
      "QUESTION: " + question;

    try {
      const out = await env.AI.run(MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
        max_tokens: MAX_ANSWER_TOKENS,
        temperature: 0.2,
      });
      const answer = (out && (out.response || out.result)) || "";
      return json({ answer }, 200, origin);
    } catch (err) {
      return json({ error: "ai_unavailable", detail: String(err) }, 429, origin);
    }
  },
};
