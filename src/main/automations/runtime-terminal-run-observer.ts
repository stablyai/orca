import { createHeadlessAutomationOutputSnapshotBuffer } from './headless-dispatch'
import type {
  AutomationRunCompletionObservation,
  AutomationRunTerminalObserver
} from './run-completion-watcher'
import type { AutomationRun, AutomationRunOutputSnapshot } from '../../shared/automations-types'
import {
  hasHeldRunTurnDone,
  judgeIdleRun,
  type AutomationRunAgentEvidence
} from './automation-run-agent-evidence'

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

async function judgeIdleTail(
  tail: readonly string[],
  evidence: AutomationRunAgentEvidence,
  run: AutomationRun,
  runStartedAt: number
): Promise<AutomationRunCompletionObservation | null> {
  const verdict = judgeIdleRun(evidence, run, tail, runStartedAt, Date.now())
  if (verdict.kind === 'wait') {
    return null
  }
  return verdict.kind === 'completed'
    ? { status: 'completed', outputSnapshot: snapshotOf(tail), error: null }
    : { status: 'dispatch_failed', outputSnapshot: snapshotOf(tail), error: verdict.error }
}

/** Rejudge unchanged idle output: an idle shell may never emit another idle edge. */
async function settleIdlePane(
  runtime: AutomationRunTerminalHost,
  handle: string,
  judged: { evidence: AutomationRunAgentEvidence; run: AutomationRun },
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
    const observation = await judgeIdleTail(tail, judged.evidence, judged.run, runStartedAt)
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

export const AGENT_HOOKS_REVIEW_BLOCKED_ERROR =
  'The agent is waiting for someone to review new or changed hooks ("Hooks need review"). Open this run and trust them, or remove them. Scheduled runs keep going and succeed once nothing needs review.'

function describeBlockedAgent(blockedReason: string): string {
  return blockedReason === 'agent-hooks-review-prompt'
    ? AGENT_HOOKS_REVIEW_BLOCKED_ERROR
    : `Automation agent is blocked: ${blockedReason}.`
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
    error: wait.blockedReason
      ? describeBlockedAgent(wait.blockedReason)
      : 'Automation agent did not report completion.'
  }
}

async function buildUnobservedObservation(
  runtime: AutomationRunTerminalHost,
  handle: string,
  error: string
): Promise<AutomationRunCompletionObservation> {
  return {
    status: 'dispatch_failed',
    outputSnapshot: await readTerminalSnapshot(runtime, handle),
    error
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
      const judged = evidence && run?.terminalPaneKey ? { evidence, run } : null
      const runStartedAt = run?.startedAt ?? run?.dispatchedAt ?? startedAt
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
            'Automation agent never started after the prompt was submitted.'
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
          // Individual wait timeouts do not prove the agent stopped working.
          if (signal.aborted || !isTerminalWaitTimeout(error)) {
            throw error
          }
          if (
            judged &&
            hasHeldRunTurnDone(
              judged.evidence,
              judged.run,
              runStartedAt,
              Date.now(),
              HELD_DONE_SETTLE_MS
            )
          ) {
            return {
              status: 'completed',
              outputSnapshot: snapshotOf(await readTail(runtime, handle)),
              error: null
            }
          }
        }
      }
      return await buildUnobservedObservation(
        runtime,
        handle,
        'Orca stopped watching this run after 6h without a completion signal.'
      )
    }
  }
}
