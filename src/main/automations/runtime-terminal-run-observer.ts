import { createHeadlessAutomationOutputSnapshotBuffer } from './headless-dispatch'
import type {
  AutomationRunCompletionObservation,
  AutomationRunTerminalObserver
} from './run-completion-watcher'
import type { AutomationRunOutputSnapshot } from '../../shared/automations-types'

const TERMINAL_SNAPSHOT_LIMIT = 2_000

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
  hasTerminalAgentWorkedSince(
    handle: string,
    observedAfter: number,
    expectedPrompt?: string,
    expectedTurnId?: string
  ): boolean
  waitForTerminal(
    handle: string,
    options?: {
      condition?: 'tui-idle'
      timeoutMs?: number
      signal?: AbortSignal
      agentTurnStartedAfter?: number
      agentTurnPrompt?: string
      agentTurnId?: string
    }
  ): Promise<{ satisfied: boolean; blockedReason?: string }>
  readTerminal(handle: string, opts?: { limit?: number }): Promise<{ tail: string[] }>
}

function isTerminalWaitTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'timeout'
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
    observeCompletion: async (
      handle,
      { signal, observedAfter, expectedPrompt, expectedTurnId }
    ) => {
      const startedAt = Date.now()
      // Why: shell startup and a ready prompt can both satisfy opposite sides of
      // tui-idle before the agent begins. Only a working lifecycle observed for
      // this run proves the later idle belongs to its completion.
      try {
        const initialWait = await runtime.waitForTerminal(handle, {
          condition: 'tui-idle',
          timeoutMs: AGENT_START_DEADLINE_MS,
          signal,
          agentTurnStartedAfter: observedAfter,
          agentTurnPrompt: expectedPrompt,
          agentTurnId: expectedTurnId
        })
        return await buildObservation(runtime, handle, initialWait)
      } catch (error) {
        if (signal.aborted || !isTerminalWaitTimeout(error)) {
          throw error
        }
        if (
          !runtime.hasTerminalAgentWorkedSince(
            handle,
            observedAfter,
            expectedPrompt,
            expectedTurnId
          )
        ) {
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
          const wait = await runtime.waitForTerminal(handle, {
            condition: 'tui-idle',
            signal,
            agentTurnStartedAfter: observedAfter,
            agentTurnPrompt: expectedPrompt,
            agentTurnId: expectedTurnId
          })
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
