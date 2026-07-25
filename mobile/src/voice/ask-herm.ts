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

import { meshVoiceBaseUrlFor } from './mesh-voice-endpoint'

// Default arm = LFM on D's iGPU. Two reasons: "what's running on this host" is a
// compressive fold over a short list, which is exactly the hybrid-attention
// lane per HERMES.md memory-class routing; and it is the fastest arm, which
// matters when a human is holding a button waiting to hear a voice. Measured
// 2026-07-21: ~5.3s to a correct spoken answer. A2c makes this configurable.
const HERM_MODEL = 'LFM2.5-8B-A1B-Q4_0.gguf'

// RECEIPT 2026-07-21: this budget must cover the arm's REASONING phase plus the
// answer, not just the answer. Every Config A arm (Qwopus, Gemma, LFM) emits
// chain-of-thought into `reasoning_content` first; when the budget runs out
// mid-reasoning the answer never starts and `content` comes back EMPTY.
//
// Reasoning length VARIES a lot for the same question (measured: 238 vs 529
// completion tokens on back-to-back identical calls), which is what made this
// hit-and-miss at 700. The cap is a CEILING, not a cost: raising it does not
// slow the normal case, because a model that is done emits finish_reason
// 'stop' and returns. Measured — max_tokens 1400 finished in 6.9s using 238
// tokens, while the same question at 700 took 15.4s using 529. So set it high.
//
// Suppression was tried and does not work on this stack: `enable_thinking:
// false` is ignored, a `/no_think` instruction is ignored, and
// `reasoning_effort` is rejected by the API outright. Do not re-litigate.
// Answer LENGTH is the system prompt's job, never this number's.
const MAX_ANSWER_TOKENS = 1600

// Mirrors the fields Orca's `worktree.ps` already streams to this client. The
// phone is authenticated to the host runtime, so live agent state is available
// as STRUCTURED data — no screenshot, no vision model, no log scraping.
export type HermWorkspaceContext = {
  hostName: string
  workspaces: {
    title: string
    repo?: string | null
    status?: string | null
    branch?: string | null
    liveTerminalCount?: number
    agents?: {
      state?: string | null
      agentType?: string | null
      /** What the operator actually asked this agent to do. */
      prompt?: string | null
      taskTitle?: string | null
      lastAssistantMessage?: string | null
      toolName?: string | null
      interrupted?: boolean
    }[]
  }[]
}

// MEASURED 2026-07-21: the raw terminal tail (`preview`) was deliberately left
// OUT of this context. Including it cost ~7s of extra reasoning (864 vs 609
// completion tokens, 25.2s vs 17.9s) AND made the answer worse — the arm
// echoed spinner noise like "Moonwalking…" back as if it were content. Agent
// state is the high-signal part; the tail is decoration. Do not add it back
// without re-measuring both latency and answer quality.
const MAX_PROMPT_CHARS = 160
const MAX_REPLY_CHARS = 200

const SYSTEM_PROMPT = [
  'You are Herm, the operator\'s strategist for the Sovereign Machina mesh.',
  'You are being asked a question OUT LOUD from a phone, and your answer will be',
  'spoken back through a speaker. So: answer in at most three short sentences.',
  'No markdown, no lists, no code blocks, no headings — plain spoken English.',
  'Be direct and concrete. If the workspace context below does not contain the',
  'answer, say so plainly instead of guessing.',
  'The context is a live snapshot of the operator\'s Orca host: each workspace',
  'lists its git branch, its status, and any coding agents running in it with',
  'what they were asked to do and what tool they are using right now.',
  'Answer from that, and refer to workspaces by name.'
].join(' ')

function truncate(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}

function renderAgent(agent: NonNullable<HermWorkspaceContext['workspaces'][number]['agents']>[number]): string {
  const bits: string[] = [`${agent.agentType ?? 'agent'} is ${agent.state ?? 'in an unknown state'}`]
  if (agent.interrupted) {
    bits.push('INTERRUPTED')
  }
  if (agent.toolName) {
    bits.push(`running tool ${agent.toolName}`)
  }
  const task = agent.taskTitle ?? agent.prompt
  if (task) {
    bits.push(`asked to: "${truncate(task, MAX_PROMPT_CHARS)}"`)
  }
  if (agent.lastAssistantMessage) {
    bits.push(`last said: "${truncate(agent.lastAssistantMessage, MAX_REPLY_CHARS)}"`)
  }
  return `    · ${bits.join('; ')}`
}

function renderContext(context: HermWorkspaceContext): string {
  if (context.workspaces.length === 0) {
    return `Host ${context.hostName || 'unknown'} has no workspaces.`
  }
  const lines = context.workspaces.flatMap((w) => {
    const head = [w.title]
    if (w.repo) {
      head.push(`repo ${w.repo}`)
    }
    if (w.branch) {
      head.push(w.branch.replace('refs/heads/', ''))
    }
    if (w.status) {
      head.push(`status ${w.status}`)
    }
    if (w.liveTerminalCount) {
      head.push(`${w.liveTerminalCount} live terminal${w.liveTerminalCount === 1 ? '' : 's'}`)
    }
    const out = [`- ${head.join(' · ')}`]
    for (const agent of w.agents ?? []) {
      out.push(renderAgent(agent))
    }
    return out
  })
  return `Live snapshot of Orca host ${context.hostName || 'unknown'}:\n${lines.join('\n')}`
}

/** Ask Herm a spoken question about the host's workspaces. Returns the answer
 *  text for the caller to speak; throws on transport/HTTP failure so the caller
 *  can surface a real error rather than silently saying nothing. */
export async function askHerm(
  question: string,
  context: HermWorkspaceContext,
  options: { hostEndpoint?: string | null; signal?: AbortSignal } = {}
): Promise<string> {
  const { hostEndpoint, signal } = options
  const res = await fetch(`${meshVoiceBaseUrlFor(hostEndpoint)}/v1/chat/completions`, {
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
