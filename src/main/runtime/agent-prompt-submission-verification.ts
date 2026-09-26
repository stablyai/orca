export { AGENT_PROMPT_EFFECT_TIMEOUT_MS } from '../../shared/orchestration-timing-budgets'
import { AGENT_PROMPT_EFFECT_TIMEOUT_MS } from '../../shared/orchestration-timing-budgets'
import type { TuiAgent } from '../../shared/tui-agent'

export const AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS = AGENT_PROMPT_EFFECT_TIMEOUT_MS
const AGENT_PROMPT_EFFECT_POLL_MS = 50

const HOOK_OBSERVED_TURN_START_AGENTS = new Set<TuiAgent>(['antigravity', 'codex', 'kimi'])

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
  /** When the hook store last recorded this agent accepting a prompt (its own prompt-submit event). */
  promptAcceptedAt: number | null
  /** Orca launched this process with its hooks, so only the agent's own prompt acceptance proves a
   *  turn: a startup spinner title or a session-start hook also reads as working. */
  requiresPromptAcceptance: boolean
}>

export type AgentPromptWaitTextCache = {
  outputSequence?: number
  waitText?: string
}

export type AgentPromptTurnStartEvidence =
  | { kind: 'lifecycle'; workingSequence: number }
  | { kind: 'hook'; workingStartedAt: number }
  | { kind: 'accepted'; acceptedAt: number }

type AgentPromptVerificationOptions = {
  baseline: AgentPromptActivity
  readActivity: () => AgentPromptActivity
  /** Accept only a turn start reserved for this request. */
  acceptTurnStart?: (evidence: AgentPromptTurnStartEvidence) => boolean
  /** Hook evidence is valid only when the baseline was captured before this request's Enter. */
  allowHookEvidence?: boolean
  /** Existing-turn output proves legacy delivery, but not a durable new-turn receipt. */
  allowOutputEvidence?: boolean
  /** One more Enter for agents that can eat the first, sent only if no turn start was accepted by
   *  `afterMs`. Returns false when the write was refused. */
  resubmit?: { afterMs: number; write: () => boolean }
  signal?: AbortSignal
  timeoutMs?: number
}

export function resolveAgentPromptEffectTimeoutMs(agent: TuiAgent | null | undefined): number {
  return agent && HOOK_OBSERVED_TURN_START_AGENTS.has(agent)
    ? AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS
    : AGENT_PROMPT_EFFECT_TIMEOUT_MS
}

/** Orca's hooks report Codex's own prompt acceptance, but only for a process Orca launched with
 *  them in this PTY incarnation; anything else keeps the working-edge rules. */
export function requiresAgentPromptAcceptance(
  pty:
    | {
        launchAgent: TuiAgent | null
        foregroundAgent: TuiAgent | null
        launchToken: string | null
        launchIncarnationId: string | null
        incarnationId: string | null
      }
    | undefined
): boolean {
  return (
    pty !== undefined &&
    pty.launchAgent === 'codex' &&
    (pty.foregroundAgent ?? pty.launchAgent) === 'codex' &&
    pty.launchToken !== null &&
    pty.launchIncarnationId === pty.incarnationId
  )
}

/** Only these providers expose a turn-start signal Orca can settle a prompt receipt against. */
export function isTerminalSendSettlementAgent(
  agent: TuiAgent | null | undefined
): agent is 'antigravity' | 'claude' | 'codex' {
  return agent === 'antigravity' || agent === 'claude' || agent === 'codex'
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

export function readAgentPromptWaitText(
  cache: AgentPromptWaitTextCache,
  outputSequence: number,
  readWaitText: () => string
): string {
  if (cache.outputSequence === outputSequence && cache.waitText !== undefined) {
    return cache.waitText
  }
  const waitText = readWaitText()
  cache.outputSequence = outputSequence
  cache.waitText = waitText
  return waitText
}

export async function verifyAgentPromptSubmission(
  options: AgentPromptVerificationOptions
): Promise<{ resubmitted: boolean }> {
  throwIfAgentPromptAborted(options.signal)
  assertPromptNotBlocked(options.baseline, options.baseline)

  const startedAt = Date.now()
  const deadline = startedAt + (options.timeoutMs ?? AGENT_PROMPT_EFFECT_TIMEOUT_MS)
  let resubmitted = false
  while (Date.now() < deadline) {
    if (checkAgentPromptEffect(options)) {
      return { resubmitted }
    }
    if (options.resubmit && !resubmitted && Date.now() - startedAt >= options.resubmit.afterMs) {
      // Why: a refused retry leaves the first Enter's verdict to the rest of the window.
      resubmitted = options.resubmit.write()
    }
    await waitForAgentPromptPoll(options.signal)
  }

  if (checkAgentPromptEffect(options)) {
    return { resubmitted }
  }
  throw new Error(AGENT_PROMPT_STALLED_ERROR)
}

function checkAgentPromptEffect(options: AgentPromptVerificationOptions): boolean {
  const current = options.readActivity()
  assertSamePromptGeneration(options.baseline, current)
  assertPromptNotBlocked(options.baseline, current)
  return agentPromptEffectAccepted(
    options.baseline,
    current,
    options.acceptTurnStart,
    options.allowHookEvidence,
    options.allowOutputEvidence
  )
}

function agentPromptEffectAccepted(
  baseline: AgentPromptActivity,
  current: AgentPromptActivity,
  acceptTurnStart?: (evidence: AgentPromptTurnStartEvidence) => boolean,
  allowHookEvidence = true,
  allowOutputEvidence = true
): boolean {
  if (baseline.requiresPromptAcceptance) {
    return (
      current.promptAcceptedAt !== null &&
      current.promptAcceptedAt > (baseline.promptAcceptedAt ?? 0) &&
      (acceptTurnStart?.({ kind: 'accepted', acceptedAt: current.promptAcceptedAt }) ?? true)
    )
  }
  if (current.workingSequence > baseline.workingSequence) {
    return (
      acceptTurnStart?.({
        kind: 'lifecycle',
        workingSequence: current.workingSequence
      }) ?? true
    )
  }
  if (allowHookEvidence && observedHookWorkingAfterBaseline(baseline, current)) {
    return (
      acceptTurnStart?.({
        kind: 'hook',
        workingStartedAt: current.explicitWorkingStartedAt!
      }) ?? true
    )
  }
  return allowOutputEvidence && observedDeliveryEvidence(baseline, current)
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
