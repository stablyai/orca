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

// Default arm = live B arm, matching config.yaml's delegation default. A2c
// makes this settings-configurable alongside the STT/TTS endpoints.
const HERM_MODEL = 'Qwopus3.6-27B-Coder-Compat-MTP-Q4_K_M.gguf'

// Spoken answers get read aloud in full, so cap length hard — a wall of text is
// a minute of talking at the user.
const MAX_ANSWER_TOKENS = 160

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
    throw new Error('Herm returned no answer')
  }
  return answer
}
