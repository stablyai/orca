// A2b — the Herm narrator's brain. A spoken question asked from the HOST panel
// is about the fleet ("what's running", "which workspace has changes"), not
// input for any one agent, so it must never be injected into a terminal. It
// goes to Herm, who answers from workspace context, and the answer is spoken
// back through the mesh Kokoro route (useMeshSpeak).
//
// Routing note (probed 2026-07-21): the `hermes-api` on node-b:8643 named in
// plans/active/2026-07-20-orca-mobile-voice-pet-canvas.md is NOT listening —
// nothing binds that port on node-b. So this goes through canonical LiteLLM
// :4000 instead, which is the sanctioned L1->L0 crossing anyway (HERMES.md
// §MESH UTILIZATION DOCTRINE) and is already reachable phone-direct over
// Tailscale for TTS. Swap to a real Herm head endpoint when one exists.

import { MESH_VOICE_BASE_URL } from './mesh-voice-turn'

// Default arm = LFM on D's iGPU. Two reasons: "what's running on this host" is a
// compressive fold over a short list, which is exactly the hybrid-attention
// lane per HERMES.md memory-class routing; and it is the fastest arm, which
// matters when a human is holding a button waiting to hear a voice. Measured
// 2026-07-21: ~5.3s to a correct spoken answer. A2c makes this configurable.
const HERM_MODEL = 'LFM2.5-8B-A1B-Q4_0.gguf'

// RECEIPT 2026-07-21: this budget must cover the arm's REASONING phase plus the
// answer, not just the answer. Every Config A arm (Qwopus, Gemma, LFM) emits
// chain-of-thought into `reasoning_content` first; at max_tokens 160 all three
// returned an EMPTY `content` because the budget ran out mid-reasoning, which
// would have failed this feature 100% of the time on the phone. At 700 the same
// question answers in 334 completion tokens with finish_reason 'stop'. Do not
// lower this to "keep spoken answers short" — the system prompt does that.
const MAX_ANSWER_TOKENS = 700

export type HermWorkspaceContext = {
  hostName: string
  workspaces: { title: string; repo?: string | null; status?: string | null }[]
}

const SYSTEM_PROMPT = [
  'You are Herm, the operator\'s strategist for the Sovereign Machina mesh.',
  'You are being asked a question OUT LOUD from a phone, and your answer will be',
  'spoken back through a speaker. So: answer in at most three short sentences.',
  'No markdown, no lists, no code blocks, no headings — plain spoken English.',
  'Be direct and concrete. If the workspace context below does not contain the',
  'answer, say so plainly instead of guessing.'
].join(' ')

function renderContext(context: HermWorkspaceContext): string {
  if (context.workspaces.length === 0) {
    return `Host ${context.hostName || 'unknown'} has no workspaces.`
  }
  const lines = context.workspaces.map((w) => {
    const bits = [w.title]
    if (w.repo) {
      bits.push(`repo ${w.repo}`)
    }
    if (w.status) {
      bits.push(w.status)
    }
    return `- ${bits.join(' · ')}`
  })
  return `Host ${context.hostName || 'unknown'} workspaces:\n${lines.join('\n')}`
}

/** Ask Herm a spoken question about the host's workspaces. Returns the answer
 *  text for the caller to speak; throws on transport/HTTP failure so the caller
 *  can surface a real error rather than silently saying nothing. */
export async function askHerm(
  question: string,
  context: HermWorkspaceContext,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(`${MESH_VOICE_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: HERM_MODEL,
      max_tokens: MAX_ANSWER_TOKENS,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${renderContext(context)}\n\nQuestion: ${question}` }
      ]
    })
  })
  if (!res.ok) {
    throw new Error(`Herm ${res.status}`)
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[]
  }
  // Why: reasoning-capable arms put the visible answer in `content` and the
  // chain-of-thought in `reasoning_content`. Never speak reasoning_content.
  const answer = body.choices?.[0]?.message?.content?.trim()
  if (!answer) {
    // Why this exact wording: an empty `content` with a populated
    // `reasoning_content` means the arm spent the whole budget thinking. That
    // is a token-budget symptom, not a network one, and saying so saves the
    // next person the probe that found it. Never fall back to speaking
    // `reasoning_content` — that is chain-of-thought, not an answer.
    throw new Error('Herm ran out of tokens before answering')
  }
  return answer
}
