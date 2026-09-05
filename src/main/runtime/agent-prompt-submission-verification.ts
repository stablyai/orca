export {
  AGENT_PROMPT_EFFECT_TIMEOUT_MS,
  AGENT_PROMPT_PENDING_COMPOSER_GRACE_MS
} from '../../shared/orchestration-timing-budgets'
import {
  AGENT_PROMPT_EFFECT_TIMEOUT_MS,
  AGENT_PROMPT_PENDING_COMPOSER_GRACE_MS,
  AGENT_PROMPT_VERIFICATION_MAX_MS
} from '../../shared/orchestration-timing-budgets'
import type { TuiAgent } from '../../shared/tui-agent'
import type { AgentPromptComposerVerdict } from './agent-prompt-composer-pending'

export const AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS = AGENT_PROMPT_EFFECT_TIMEOUT_MS
const AGENT_PROMPT_EFFECT_POLL_MS = 50
/** When, after Enter, the composer is re-read and a still-parked payload gets Enter again.
 *  Backs off so a slow first turn is not hammered, yet reaches a TUI that ate the first Enter
 *  while it was still absorbing the paste (Codex over Windows console input records). */
export const AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS: readonly number[] = [
  1_500, 4_000, 9_000, 18_000, 36_000
]
/** A cleared composer must hold for this long before it counts as the payload being consumed. */
export const AGENT_PROMPT_COMPOSER_CLEAR_CONFIRM_MS = 500

const HOOK_OBSERVED_TURN_START_AGENTS = new Set<TuiAgent>(['codex', 'kimi'])

/** The prompt bytes are written before verification, so this only ever means "not observed". */
export const AGENT_PROMPT_STALLED_ERROR = 'agent_prompt_stalled'

export class AgentPromptStalledError extends Error {
  constructor(
    /** What the rendered composer showed when the verdict was reached. */
    readonly composer: AgentPromptComposerVerdict,
    /** Extra Enters written after the first one. */
    readonly enterRetries: number
  ) {
    super(AGENT_PROMPT_STALLED_ERROR)
    this.name = 'AgentPromptStalledError'
  }
}

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

export type AgentPromptWaitTextCache = {
  outputSequence?: number
  waitText?: string
}

/** Rendered-screen view of the composer, for callers that can read one. */
export type AgentPromptComposerObserver = {
  /** Verdict read after the paste settled and before the first Enter. */
  beforeSubmit: AgentPromptComposerVerdict
  read: () => Promise<AgentPromptComposerVerdict>
  /** Writes one more Enter; only invoked while the payload is visibly parked and nothing blocks. */
  resubmit: () => Promise<void> | void
  retryDelaysMs?: readonly number[]
  pendingGraceMs?: number
}

export type AgentPromptSubmissionOutcome = {
  /** `activity`: a turn-start/hook/output proof; `composer-cleared`: the parked payload vanished. */
  evidence: 'activity' | 'composer-cleared'
  enterRetries: number
}

type AgentPromptVerificationOptions = {
  baseline: AgentPromptActivity
  readActivity: () => AgentPromptActivity
  timeoutMs?: number
  signal?: AbortSignal
  composer?: AgentPromptComposerObserver
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
): Promise<AgentPromptSubmissionOutcome> {
  throwIfAgentPromptAborted(options.signal)
  assertPromptNotBlocked(options.baseline, options.baseline)

  const startedAt = Date.now()
  let deadline = startedAt + (options.timeoutMs ?? AGENT_PROMPT_EFFECT_TIMEOUT_MS)
  const composer = options.composer
  const retryDelaysMs = composer?.retryDelaysMs ?? AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS
  let nextCheckpoint = 0
  let enterRetries = 0
  let lastVerdict: AgentPromptComposerVerdict = composer?.beforeSubmit ?? 'unknown'
  let sawPending = lastVerdict === 'pending'
  let clearObservedAt: number | null = null
  let graceApplied = false

  const activityObserved = (): boolean => {
    const current = options.readActivity()
    assertSamePromptGeneration(options.baseline, current)
    assertPromptNotBlocked(options.baseline, current)
    return agentPromptEffectObserved(options.baseline, current)
  }
  // Why: a busy agent keeps painting after Enter whether or not it took the paste, and its session
  // hook can already read `working`. Activity therefore proves nothing while the payload is still on
  // screen; the composer's last verdict has to release it first. While that holds, the composer is
  // re-read at most once per confirm window so a retry that lands is noticed without hammering.
  let lastComposerReadAt = -Infinity
  const activityProvesSubmission = async (): Promise<boolean> => {
    if (!composer || !sawPending || lastVerdict !== 'pending') {
      return true
    }
    if (Date.now() - lastComposerReadAt < AGENT_PROMPT_COMPOSER_CLEAR_CONFIRM_MS) {
      return false
    }
    lastComposerReadAt = Date.now()
    lastVerdict = await composer.read()
    throwIfAgentPromptAborted(options.signal)
    return lastVerdict !== 'pending' && activityObserved()
  }

  while (Date.now() < deadline) {
    const elapsed = Date.now() - startedAt
    const checkpointDue =
      composer !== undefined &&
      nextCheckpoint < retryDelaysMs.length &&
      elapsed >= retryDelaysMs[nextCheckpoint]!
    const confirmDue =
      clearObservedAt !== null &&
      Date.now() - clearObservedAt >= AGENT_PROMPT_COMPOSER_CLEAR_CONFIRM_MS
    // Why: a due checkpoint owns this iteration's read, so a parked payload gets its Enter before
    // the activity path can spend the read and swallow the retry.
    if (activityObserved() && !checkpointDue && !confirmDue && (await activityProvesSubmission())) {
      return { evidence: 'activity', enterRetries }
    }
    if (composer) {
      if (checkpointDue || confirmDue) {
        if (checkpointDue) {
          nextCheckpoint += 1
        }
        throwIfAgentPromptAborted(options.signal)
        lastComposerReadAt = Date.now()
        lastVerdict = await composer.read()
        throwIfAgentPromptAborted(options.signal)
        // Why: the read is asynchronous; a turn start or a permission dialog may have landed meanwhile.
        if (lastVerdict !== 'pending' && activityObserved()) {
          return { evidence: 'activity', enterRetries }
        }
        if (lastVerdict === 'pending') {
          sawPending = true
          clearObservedAt = null
          if (checkpointDue) {
            throwIfAgentPromptAborted(options.signal)
            await composer.resubmit()
            enterRetries += 1
            if (!graceApplied) {
              // Why the cap: budgets downstream are derived from the verification ceiling.
              deadline = Math.min(
                deadline + (composer.pendingGraceMs ?? AGENT_PROMPT_PENDING_COMPOSER_GRACE_MS),
                startedAt + AGENT_PROMPT_VERIFICATION_MAX_MS
              )
              graceApplied = true
            }
          }
        } else if (lastVerdict === 'clear' && sawPending) {
          // Why two reads: a frame caught mid-redraw can look empty; a payload that was on screen
          // and stays gone across the confirm window was consumed by the TUI.
          if (clearObservedAt === null) {
            clearObservedAt = Date.now()
          } else if (confirmDue) {
            return { evidence: 'composer-cleared', enterRetries }
          }
        } else {
          clearObservedAt = null
        }
      }
    }
    await waitForAgentPromptPoll(options.signal)
  }

  if (activityObserved() && (await activityProvesSubmission())) {
    return { evidence: 'activity', enterRetries }
  }
  throw new AgentPromptStalledError(lastVerdict, enterRetries)
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
