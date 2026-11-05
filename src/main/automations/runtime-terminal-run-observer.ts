import { createHeadlessAutomationOutputSnapshotBuffer } from './headless-dispatch'
import type {
  AutomationRunCompletionObservation,
  AutomationRunTerminalObserver
} from './run-completion-watcher'
import type { AutomationRunOutputSnapshot } from '../../shared/automations-types'
import {
  AUTOMATION_RUN_FAILURE_COPY,
  automationRunFailure,
  type AutomationRunFailure
} from '../../shared/automation-run-failure-copy'
import {
  judgeHeldRunTurn,
  judgeIdleRun,
  captureRunAgentTurn,
  judgeRunExit,
  type AutomationRunAgentEvidence,
  type JudgedRun,
  type IdleRunVerdict
} from './automation-run-agent-evidence'
import { readProvenTerminalExit } from '../runtime/terminal-wait-results'

const TERMINAL_SNAPSHOT_LIMIT = 2_000

const AGENT_EVIDENCE_POLL_INTERVAL_MS = 1_000
const AGENT_START_POLL_INTERVAL_MS = 250
/** Stay below the runtime's 2s fallback to avoid starting a foreground-process poll. */
const AGENT_START_PROBE_TIMEOUT_MS = 250
/** Allow prompt submission delays and SSH startup before declaring the agent unstarted. */
const AGENT_START_DEADLINE_MS = 2 * 60 * 1000
/** How long the agent's own `done` must stand before it settles a run whose screen never reads
 *  idle (a lost stream or an unknown idle screen, #34064); past any blocked verdict a screen gives. */
const HELD_DONE_SETTLE_MS = 30_000
/** Bound re-arming per observation; startup reconciliation can attach again. */
const OBSERVE_DEADLINE_MS = 6 * 60 * 60 * 1000

export type AutomationRunTerminalHost = {
  getTerminalHandleForPaneKey(paneKey: string): string | null
  waitForTerminal(
    handle: string,
    options?: { condition?: 'tui-idle'; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ satisfied: boolean; blockedReason?: string }>
  readTerminal(handle: string, opts?: { limit?: number }): Promise<{ tail: string[] }>
}

async function readTail(runtime: AutomationRunTerminalHost, handle: string): Promise<string[]> {
  try {
    return (await runtime.readTerminal(handle, { limit: TERMINAL_SNAPSHOT_LIMIT })).tail
  } catch {
    return []
  }
}

function snapshotOf(tail: readonly string[]): AutomationRunOutputSnapshot | null {
  const snapshotBuffer = createHeadlessAutomationOutputSnapshotBuffer()
  snapshotBuffer.append(tail.join('\n'))
  return snapshotBuffer.snapshot()
}

/** A finished run keeps what the agent answered; the screen is the fallback for agents without hooks. */
function completedSnapshot(
  tail: readonly string[],
  judged: JudgedRun | null
): AutomationRunOutputSnapshot | null {
  const reply = judged?.turn()?.reply ?? null
  const snapshot = snapshotOf(reply ? [reply.text] : tail)
  return snapshot && reply?.truncated ? { ...snapshot, truncated: true } : snapshot
}

async function judgeIdleTail(
  tail: readonly string[],
  judged: JudgedRun,
  runStartedAt: number
): Promise<AutomationRunCompletionObservation | null> {
  const verdict = judgeIdleRun(judged.evidence, judged.run, tail, runStartedAt, Date.now())
  return verdict.kind === 'wait' ? null : observationOf(verdict, tail, judged)
}

function observationOf(
  verdict: Exclude<IdleRunVerdict, { kind: 'wait' }>,
  tail: readonly string[],
  judged: JudgedRun | null
): AutomationRunCompletionObservation {
  if (verdict.kind === 'completed') {
    return {
      status: 'completed',
      outputSnapshot: completedSnapshot(tail, judged),
      error: null
    }
  }
  const { kind: _kind, ...failure } = verdict
  return { status: 'dispatch_failed', outputSnapshot: snapshotOf(tail), ...failure }
}

/** Rejudge unchanged idle output: an idle shell may never emit another idle edge. */
async function settleIdlePane(
  runtime: AutomationRunTerminalHost,
  handle: string,
  judged: JudgedRun,
  runStartedAt: number,
  signal: AbortSignal,
  deadlineAt: number
): Promise<AutomationRunCompletionObservation | null> {
  const idleTail = (await readTail(runtime, handle)).join('\n')
  while (Date.now() < deadlineAt) {
    const tail = await readTail(runtime, handle)
    if (tail.join('\n') !== idleTail) {
      return null
    }
    const observation = await judgeIdleTail(tail, judged, runStartedAt)
    if (observation) {
      return observation
    }
    await sleep(AGENT_EVIDENCE_POLL_INTERVAL_MS, signal)
  }
  return null
}

function isTerminalWaitTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'timeout'
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('request_aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('request_aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Reuse runtime idle detection across sticky status, pane titles and ready shell prompts. */
async function isTuiIdleSatisfiedNow(
  runtime: AutomationRunTerminalHost,
  handle: string,
  signal: AbortSignal
): Promise<boolean> {
  try {
    const wait = await runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs: AGENT_START_PROBE_TIMEOUT_MS,
      signal
    })
    return wait.satisfied
  } catch (error) {
    if (isTerminalWaitTimeout(error)) {
      return false
    }
    throw error
  }
}

async function waitForAgentStart(
  runtime: AutomationRunTerminalHost,
  handle: string,
  signal: AbortSignal,
  deadlineAt: number
): Promise<boolean> {
  while (Date.now() < deadlineAt) {
    await sleep(AGENT_START_POLL_INTERVAL_MS, signal)
    if (!(await isTuiIdleSatisfiedNow(runtime, handle, signal))) {
      return true
    }
  }
  return false
}

export const AGENT_HOOKS_REVIEW_BLOCKED_ERROR = AUTOMATION_RUN_FAILURE_COPY.hooksReviewBlocked

function describeBlockedAgent(blockedReason: string): AutomationRunFailure {
  return blockedReason === 'agent-hooks-review-prompt'
    ? automationRunFailure('hooksReviewBlocked')
    : { error: `Automation agent is blocked: ${blockedReason}.` }
}

async function readTerminalSnapshot(
  runtime: AutomationRunTerminalHost,
  handle: string
): Promise<AutomationRunOutputSnapshot | null> {
  const snapshotBuffer = createHeadlessAutomationOutputSnapshotBuffer()
  try {
    const read = await runtime.readTerminal(handle, { limit: TERMINAL_SNAPSHOT_LIMIT })
    snapshotBuffer.append(read.tail.join('\n'))
  } catch {
    // A terminal may exit after the wait succeeds; snapshot failure must not change its outcome.
  }
  return snapshotBuffer.snapshot()
}

async function buildObservation(
  runtime: AutomationRunTerminalHost,
  handle: string,
  wait: { satisfied: boolean; blockedReason?: string }
): Promise<AutomationRunCompletionObservation> {
  const outputSnapshot = await readTerminalSnapshot(runtime, handle)
  if (wait.satisfied) {
    return { status: 'completed', outputSnapshot, error: null }
  }
  return {
    status: 'dispatch_failed',
    outputSnapshot,
    ...(wait.blockedReason
      ? describeBlockedAgent(wait.blockedReason)
      : automationRunFailure('agentNoCompletion'))
  }
}

async function buildUnobservedObservation(
  runtime: AutomationRunTerminalHost,
  handle: string,
  failure: AutomationRunFailure
): Promise<AutomationRunCompletionObservation> {
  return {
    status: 'dispatch_failed',
    outputSnapshot: await readTerminalSnapshot(runtime, handle),
    ...failure
  }
}

export function createRuntimeAutomationRunTerminalObserver(
  runtime: AutomationRunTerminalHost,
  /** Agent evidence discounts prior-run idleness; without it, require a busy-to-idle transition. */
  evidence?: AutomationRunAgentEvidence
): AutomationRunTerminalObserver {
  return {
    resolveRunTerminal: (run) =>
      run.terminalPaneKey ? runtime.getTerminalHandleForPaneKey(run.terminalPaneKey) : null,
    observeCompletion: async (handle, { signal, run }) => {
      const startedAt = Date.now()
      const runStartedAt = run?.startedAt ?? run?.dispatchedAt ?? startedAt
      const judged =
        evidence && run?.terminalPaneKey ? captureRunAgentTurn(evidence, run, runStartedAt) : null
      try {
        return await observeTerminalRun(runtime, handle, signal, judged, startedAt, runStartedAt)
      } finally {
        judged?.stop()
      }
    }
  }
}

async function observeTerminalRun(
  runtime: AutomationRunTerminalHost,
  handle: string,
  signal: AbortSignal,
  judged: JudgedRun | null,
  startedAt: number,
  runStartedAt: number
): Promise<AutomationRunCompletionObservation> {
  // Without agent evidence, require a busy edge to exclude a previous run's idle state.
  if (!judged && (await isTuiIdleSatisfiedNow(runtime, handle, signal))) {
    const started = await waitForAgentStart(
      runtime,
      handle,
      signal,
      startedAt + AGENT_START_DEADLINE_MS
    )
    if (!started) {
      return await buildUnobservedObservation(
        runtime,
        handle,
        automationRunFailure('agentNeverStarted')
      )
    }
  }
  const deadlineAt = startedAt + OBSERVE_DEADLINE_MS
  while (Date.now() < deadlineAt) {
    try {
      const wait = await runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        signal,
        ...(judged ? { timeoutMs: HELD_DONE_SETTLE_MS } : {})
      })
      if (!judged || !wait.satisfied) {
        return await buildObservation(runtime, handle, wait)
      }
      const observation = await settleIdlePane(
        runtime,
        handle,
        judged,
        runStartedAt,
        signal,
        deadlineAt
      )
      if (observation) {
        return observation
      }
    } catch (error) {
      const exit = signal.aborted ? null : readProvenTerminalExit(error)
      if (exit) {
        return observationOf(judgeRunExit(exit, judged), await readTail(runtime, handle), judged)
      }
      // Individual wait timeouts do not prove the agent stopped working.
      if (signal.aborted || !isTerminalWaitTimeout(error)) {
        throw error
      }
      const held = judged
        ? judgeHeldRunTurn(
            judged.evidence,
            judged.run,
            runStartedAt,
            Date.now(),
            HELD_DONE_SETTLE_MS
          )
        : null
      if (held) {
        return observationOf(held, await readTail(runtime, handle), judged)
      }
    }
  }
  return await buildUnobservedObservation(runtime, handle, automationRunFailure('watchTimedOut'))
}
