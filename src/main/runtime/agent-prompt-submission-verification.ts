import { AGENT_PROMPT_EFFECT_TIMEOUT_MS } from '../../shared/orchestration-timing-budgets'
import type { TerminalAgent } from '../../shared/terminal-agent'

export const AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS = AGENT_PROMPT_EFFECT_TIMEOUT_MS
const AGENT_PROMPT_EFFECT_POLL_MS = 50

const HOOK_OBSERVED_TURN_START_AGENTS = new Set<TerminalAgent>(['antigravity', 'codex', 'kimi'])

/** The prompt bytes are written before verification, so this only ever means "not observed". */
export const AGENT_PROMPT_STALLED_ERROR = 'agent_prompt_stalled'

export type AgentPromptActivity = Readonly<{
  generation: number
  permissionSequence: number
  workingSequence: number
  /** Hook turn start, pinned across same-state pings and available without a window/title. */
  explicitWorkingStartedAt: number | null
  /** Post-Enter pane bytes can prove delivery when no turn-start edge is observable. */
  outputSequence: number
  status: 'working' | 'permission' | 'idle' | null
}>

export type AgentPromptWaitTextCache = {
  outputSequence?: number
  waitText?: string
}

export type AgentPromptTurnStartEvidence =
  | { kind: 'lifecycle'; workingSequence: number }
  | { kind: 'hook'; workingStartedAt: number }

type AgentPromptVerificationOptions = {
  baseline: AgentPromptActivity
  readActivity: () => AgentPromptActivity
  /** Accept only a turn start reserved for this request. */
  acceptTurnStart?: (evidence: AgentPromptTurnStartEvidence) => boolean
  /** Hook evidence is valid only when the baseline was captured before this request's Enter. */
  allowHookEvidence?: boolean
  /** Existing-turn output proves legacy delivery, but not a durable new-turn receipt. */
  allowOutputEvidence?: boolean
  signal?: AbortSignal
  timeoutMs?: number
}

export function resolveAgentPromptEffectTimeoutMs(agent: TerminalAgent | null | undefined): number {
  return agent && HOOK_OBSERVED_TURN_START_AGENTS.has(agent)
    ? AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS
    : AGENT_PROMPT_EFFECT_TIMEOUT_MS
}

export function isTerminalSendSettlementAgent(
  agent: TerminalAgent | null | undefined
): agent is 'antigravity' | 'claude' | 'codex' {
  return agent === 'antigravity' || agent === 'claude' || agent === 'codex'
}

export function isAgentPromptStalledError(error: unknown): boolean {
  if (error instanceof Error && error.message === AGENT_PROMPT_STALLED_ERROR) {
    return true
  }
  // Relayed submissions carry the verdict in RPC error code, not message.
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
): Promise<void> {
  throwIfAgentPromptAborted(options.signal)
  assertPromptNotBlocked(options.baseline, options.baseline)

  const deadline = Date.now() + (options.timeoutMs ?? AGENT_PROMPT_EFFECT_TIMEOUT_MS)
  while (Date.now() < deadline) {
    const current = options.readActivity()
    assertSamePromptGeneration(options.baseline, current)
    assertPromptNotBlocked(options.baseline, current)
    if (
      agentPromptEffectAccepted(
        options.baseline,
        current,
        options.acceptTurnStart,
        options.allowHookEvidence,
        options.allowOutputEvidence
      )
    ) {
      return
    }
    await waitForAgentPromptPoll(options.signal)
  }

  const current = options.readActivity()
  assertSamePromptGeneration(options.baseline, current)
  assertPromptNotBlocked(options.baseline, current)
  if (
    agentPromptEffectAccepted(
      options.baseline,
      current,
      options.acceptTurnStart,
      options.allowHookEvidence,
      options.allowOutputEvidence
    )
  ) {
    return
  }
  throw new Error(AGENT_PROMPT_STALLED_ERROR)
}

function agentPromptEffectAccepted(
  baseline: AgentPromptActivity,
  current: AgentPromptActivity,
  acceptTurnStart?: (evidence: AgentPromptTurnStartEvidence) => boolean,
  allowHookEvidence = true,
  allowOutputEvidence = true
): boolean {
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

// Direct hooks survive hidden/headless operation; require a new stateStartedAt, never a refreshed same-state ping (#16095).
function observedHookWorkingAfterBaseline(
  baseline: AgentPromptActivity,
  current: AgentPromptActivity
): boolean {
  return (
    current.explicitWorkingStartedAt !== null &&
    current.explicitWorkingStartedAt > (baseline.explicitWorkingStartedAt ?? 0)
  )
}

// Already-working agents cannot emit a new working edge; post-Enter bytes prove delivery. Idle agents still owe a turn start.
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
