import { createHeadlessAutomationOutputSnapshotBuffer } from './headless-dispatch'
import type {
  AutomationRunCompletionObservation,
  AutomationRunTerminalObserver
} from './run-completion-watcher'
import type { AutomationRunOutputSnapshot } from '../../shared/automations-types'

const TERMINAL_SNAPSHOT_LIMIT = 2_000

/** Cadence for re-probing a pane that already satisfied tui-idle at dispatch. */
const AGENT_START_POLL_INTERVAL_MS = 250
/** Kept under the runtime's 2s tui-idle fallback poll so a probe waiter is torn
 *  down before it can start a foreground-process poll of its own. */
const AGENT_START_PROBE_TIMEOUT_MS = 250
/** How long a pane may stay in its pre-dispatch state before we stop believing
 *  the prompt reached an agent. Covers the deliberate pre-Enter delay plus agent
 *  spin-up over SSH; past that, silence is not evidence of work. */
const AGENT_START_DEADLINE_MS = 2 * 60 * 1000
/** Total observation budget. Each tui-idle wait expires on the runtime's own
 *  5-minute schedule and a live agent legitimately outlives many of them, so the
 *  bound is wall-clock and generous; it exists so a pane whose agent is never
 *  detected stops re-arming for the process lifetime with its run stuck at
 *  `dispatched`. Startup reconciliation re-attaches, so this is not a hard cap on
 *  how long a surviving run may be watched across restarts. */
const OBSERVE_DEADLINE_MS = 6 * 60 * 60 * 1000

/** The runtime surface an authority uses to observe its own terminals. */
export type AutomationRunTerminalHost = {
  getTerminalHandleForPaneKey(paneKey: string): string | null
  waitForTerminal(
    handle: string,
    options?: { condition?: 'tui-idle'; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ satisfied: boolean; blockedReason?: string }>
  readTerminal(handle: string, opts?: { limit?: number }): Promise<{ tail: string[] }>
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

/** Whether tui-idle is satisfiable from evidence the pane holds RIGHT NOW.
 *  Why a real wait with a short timeout rather than a status read: the runtime
 *  satisfies tui-idle from a sticky agent status, an idle pane title, or a ready
 *  shell prompt, across two different code shapes (pty vs leaf). Asking it the
 *  question it already answers keeps every one of those in scope. */
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
    // A blocked pane is not "already finished"; let the real wait report it.
    return wait.satisfied
  } catch (error) {
    if (isTerminalWaitTimeout(error)) {
      return false
    }
    throw error
  }
}

/** Polls until the pane stops satisfying tui-idle — the edge that proves this
 *  run's agent, not the previous one, owns the pane. */
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

async function readTerminalSnapshot(
  runtime: AutomationRunTerminalHost,
  handle: string
): Promise<AutomationRunOutputSnapshot | null> {
  const snapshotBuffer = createHeadlessAutomationOutputSnapshotBuffer()
  try {
    const read = await runtime.readTerminal(handle, { limit: TERMINAL_SNAPSHOT_LIMIT })
    snapshotBuffer.append(read.tail.join('\n'))
  } catch {
    // Why: the terminal can exit between the wait resolving and the tail read;
    // a missing snapshot must not turn a satisfied wait into a failure.
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
      ? `Automation agent is blocked: ${wait.blockedReason}.`
      : 'Automation agent did not report completion.'
  }
}

/** Closes a run out without claiming a completion nobody observed. */
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
  runtime: AutomationRunTerminalHost
): AutomationRunTerminalObserver {
  return {
    resolveRunTerminal: (run) =>
      run.terminalPaneKey ? runtime.getTerminalHandleForPaneKey(run.terminalPaneKey) : null,
    observeCompletion: async (handle, { signal }) => {
      const startedAt = Date.now()
      // Why: tui-idle is level-triggered, so a reused pane still idle from the
      // PREVIOUS run satisfies it before this run's agent has typed a character.
      // Evidence that predates dispatch proves nothing about this run, so require
      // the pane to leave that state first — the busy edge the renderer's own
      // dispatch observer requires on reuse (requireWorkingAfterStart).
      if (await isTuiIdleSatisfiedNow(runtime, handle, signal)) {
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
      for (;;) {
        try {
          const wait = await runtime.waitForTerminal(handle, { condition: 'tui-idle', signal })
          return await buildObservation(runtime, handle, wait)
        } catch (error) {
          // Why: tui-idle waits expire on their own schedule; an agent still
          // working past that window is live, so re-arm rather than fail it.
          if (signal.aborted || !isTerminalWaitTimeout(error)) {
            throw error
          }
          if (Date.now() >= deadlineAt) {
            return await buildUnobservedObservation(
              runtime,
              handle,
              'Orca stopped watching this run after 6h without a completion signal.'
            )
          }
        }
      }
    }
  }
}
