import type { TuiAgent } from '../../shared/tui-agent'

export const AGENT_PROMPT_EFFECT_TIMEOUT_MS = 5_000
// Why: these panes prove a turn start only through the out-of-process hook — kimi has no synthetic
// title profile and codex suppresses the hook-driven working frame (synthesizeWorkingTitle: false),
// so the first proof lags Enter by agent startup, not by one TUI repaint. Capped so the worst case
// (8s render gate + this wait + chunked paste) still fits RELAY_TO_CLIENT_REQUEST_TIMEOUT_MS
// (30s, src/relay/dispatcher.ts), the budget a paired client's submission runs under.
export const AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS = 15_000
const AGENT_PROMPT_EFFECT_POLL_MS = 50

const HOOK_OBSERVED_TURN_START_AGENTS = new Set<TuiAgent>(['codex', 'kimi'])

/** The prompt bytes are written before verification, so this only ever means "not observed". */
export const AGENT_PROMPT_STALLED_ERROR = 'agent_prompt_stalled'

export type AgentPromptActivity = Readonly<{
  generation: number
  permissionSequence: number
  workingSequence: number
  /** When the hook's current `working` turn began; reaches the runtime with no window and no
   *  title coverage. Pinned across same-state pings, so a refresh alone cannot move it. */
  explicitWorkingStartedAt: number | null
  /** PTY bytes seen on this pane; delivery evidence when a turn-start edge cannot be observed. */
  outputSequence: number
  status: 'working' | 'permission' | 'idle' | null
}>

type AgentPromptVerificationOptions = {
  baseline: AgentPromptActivity
  readActivity: () => AgentPromptActivity
  timeoutMs?: number
  signal?: AbortSignal
}

export function resolveAgentPromptEffectTimeoutMs(agent: TuiAgent | null | undefined): number {
  return agent && HOOK_OBSERVED_TURN_START_AGENTS.has(agent)
    ? AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS
    : AGENT_PROMPT_EFFECT_TIMEOUT_MS
}

export function isAgentPromptStalledError(error: unknown): boolean {
  if (error instanceof Error && error.message === AGENT_PROMPT_STALLED_ERROR) {
    return true
  }
  // Why: a relayed submission surfaces the same verdict as an RPC error code, not a message.
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === AGENT_PROMPT_STALLED_ERROR
  )
}

export async function verifyAgentPromptSubmission(
  options: AgentPromptVerificationOptions
): Promise<void> {
  throwIfAgentPromptAborted(options.signal)
  assertPromptNotBlocked(options.baseline, options.baseline)

  const deadline = Date.now() + (options.timeoutMs ?? AGENT_PROMPT_EFFECT_TIMEOUT_MS)
  while (Date.now() < deadline) {
    const current = options.readActivity()
    assertSamePromptGeneration(options.baseline, current)
    assertPromptNotBlocked(options.baseline, current)
    if (agentPromptEffectObserved(options.baseline, current)) {
      return
    }
    await waitForAgentPromptPoll(options.signal)
  }

  const current = options.readActivity()
  assertSamePromptGeneration(options.baseline, current)
  assertPromptNotBlocked(options.baseline, current)
  if (agentPromptEffectObserved(options.baseline, current)) {
    return
  }
  throw new Error(AGENT_PROMPT_STALLED_ERROR)
}

function agentPromptEffectObserved(
  baseline: AgentPromptActivity,
  current: AgentPromptActivity
): boolean {
  return (
    current.workingSequence > baseline.workingSequence ||
    observedHookWorkingAfterBaseline(baseline, current) ||
    observedDeliveryEvidence(baseline, current)
  )
}

// Why: hook status reaches the runtime directly, so it survives a hidden window and headless serve —
// the synthetic-title route that feeds workingSequence does not (#16095). Only a turn that started
// after the baseline counts, so a same-state ping on the turn already running is not evidence.
function observedHookWorkingAfterBaseline(
  baseline: AgentPromptActivity,
  current: AgentPromptActivity
): boolean {
  return (
    current.explicitWorkingStartedAt !== null &&
    current.explicitWorkingStartedAt > (baseline.explicitWorkingStartedAt ?? 0)
  )
}

// Why: a `→working` edge is unreachable for an agent that is already working, so the honest proof
// that the prompt landed is the pane emitting bytes after Enter. An idle agent still owes a real
// turn start, which keeps a swallowed Enter detectable.
function observedDeliveryEvidence(
  baseline: AgentPromptActivity,
  current: AgentPromptActivity
): boolean {
  return baseline.status === 'working' && current.outputSequence > baseline.outputSequence
}

function assertSamePromptGeneration(
  baseline: AgentPromptActivity,
  current: AgentPromptActivity
): void {
  if (current.generation !== baseline.generation) {
    throw new Error('terminal_handle_stale')
  }
}

function assertPromptNotBlocked(baseline: AgentPromptActivity, current: AgentPromptActivity): void {
  if (current.status === 'permission' || current.permissionSequence > baseline.permissionSequence) {
    throw new Error('agent_prompt_blocked')
  }
}

function throwIfAgentPromptAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('request_aborted')
  }
}

async function waitForAgentPromptPoll(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, AGENT_PROMPT_EFFECT_POLL_MS))
    return
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('request_aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, AGENT_PROMPT_EFFECT_POLL_MS)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
  })
}
