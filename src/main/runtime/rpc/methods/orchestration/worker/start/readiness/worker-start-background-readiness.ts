import type { TuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent'
import {
  createSetupWaitGate,
  SETUP_WAIT_GATE_MAX_MS
} from '../../../../../../../../shared/agent-launch/startup/setup-wait-output-gate'
import { readTerminalStartFailure } from '../../../../../../../../shared/terminal/pty/lifecycle/terminal-start-failure'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason
} from '../../../../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../../orchestration/db/orchestration-db'
import {
  reportBlockedWorkerStart,
  reportNeverReadyWorkerStart,
  readWorkerStartScreen
} from '../../../../../../orchestration/workers/turn-stops/awaiting-worker-start-report'
import {
  freshLaunchPtyId,
  waitForWorkerAgentReady,
  type TerminalReadinessCreation
} from '../../../../../../terminal/wait/launched-agent-composer-readiness'
import type { WorkerSetupReceipt } from '../placement/worker-placement-topology'
import { WORKER_AWAITING_AGENT_STAGE } from '../../../../../../orchestration/db/worker-dispatch/worker-awaiting-agent-stage'

const READY_DEADLINE_MS = 10 * 60_000

/** How long after launch (after Setup) an agent may take to become ready before its start fails. */
export function workerStartReadyDeadlineMs(): number {
  const override = Number(process.env.ORCA_WORKER_START_READY_DEADLINE_MS)
  return Number.isFinite(override) && override > 0 ? override : READY_DEADLINE_MS
}

/** One wait per Dispatch, in this runtime only: a restart ends it (see settleRestartCutWorkerStart). */
const waits = new Map<string, AbortController>()

/** A stop or abandon ends the wait; the Dispatch's own state already says why. */
export function cancelWorkerStartWait(dispatchId: string): void {
  waits.get(dispatchId)?.abort()
}

export type WorkerReadinessWaitArgs = {
  agent: TuiAgent | undefined
  reusesTerminal: boolean
  creation?: TerminalReadinessCreation
}

/** Why the caller's readiness wait ended unready in a way waiting on can still fix: time ran out, or a
 *  screen only a person can answer is up. Null for a real failure (exit, launch error). */
export function readinessStillPending(
  outcome: { wait: RuntimeTerminalWait } | { error: unknown }
): { blockedReason?: RuntimeTerminalWaitBlockedReason } | null {
  if ('wait' in outcome) {
    return !outcome.wait.satisfied && outcome.wait.blockedReason
      ? { blockedReason: outcome.wait.blockedReason }
      : null
  }
  const { error } = outcome
  return error instanceof Error && error.message === 'timeout' && !readTerminalStartFailure(error)
    ? {}
    : null
}

export type AwaitingWorkerStart = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  terminalHandle: string
  readiness: WorkerReadinessWaitArgs
  setup: WorkerSetupReceipt
  /** When the agent was launched; its deadline counts from here unless Setup holds it. */
  launchedAt: number
  blockedReason?: RuntimeTerminalWaitBlockedReason
  /** Types the brief and settles the start, as a start ready in time does. */
  handOver: () => Promise<void>
  /** Fails the start as the caller's own failure would. */
  fail: (error: unknown, failedStage: string) => Promise<void>
}

/** Moves the start to its awaiting stage and watches on; the caller returns at once. */
export function awaitWorkerAgentInBackground(start: AwaitingWorkerStart): { readyBy: number } {
  start.db.recordWorkerStage({ dispatchId: start.dispatchId, stage: WORKER_AWAITING_AGENT_STAGE })
  const controller = new AbortController()
  waits.get(start.dispatchId)?.abort()
  waits.set(start.dispatchId, controller)
  const gated = start.setup.startupPolicy === 'wait-for-setup' && start.setup.effective === 'run'
  void watch(start, controller.signal, gated)
    .catch((error: unknown) => {
      console.warn('[orchestration] waiting for a worker agent failed', start.dispatchId, error)
    })
    .finally(() => {
      if (waits.get(start.dispatchId) === controller) {
        waits.delete(start.dispatchId)
      }
    })
  // A gated launch's clock starts when Setup ends; until then the receipt can only bound it from now.
  return { readyBy: (gated ? Date.now() : start.launchedAt) + workerStartReadyDeadlineMs() }
}

async function watch(start: AwaitingWorkerStart, signal: AbortSignal, gated: boolean) {
  const { runtime, db, dispatchId, terminalHandle } = start
  const awaiting = () => {
    const worker = db.getWorkerDispatch(dispatchId)
    return (
      !signal.aborted &&
      worker?.state === 'starting' &&
      worker.stage === WORKER_AWAITING_AGENT_STAGE
    )
  }
  const ptyId = () =>
    (!start.readiness.reusesTerminal &&
      freshLaunchPtyId(terminalHandle, start.readiness.creation)) ||
    runtime.getTerminalPtyIdForHandle(terminalHandle)
  if (gated) {
    const id = ptyId()
    const setup = id ? await setupEnd(runtime, id, signal) : 'started'
    if (!awaiting()) {
      return
    }
    if (setup === 'failed') {
      await start.fail(
        new Error('Setup failed or timed out, so its agent never started.'),
        'setup_wait'
      )
      return
    }
  }
  const deadline = (gated ? Date.now() : start.launchedAt) + workerStartReadyDeadlineMs()
  let blocked = start.blockedReason
  if (blocked) {
    await reportBlockedWorkerStart(runtime, db, dispatchId, terminalHandle, blocked, deadline)
  }
  for (;;) {
    if (blocked) {
      // A screen only a person answers changes only when they do: nothing to read until it repaints.
      const id = ptyId()
      if (id) {
        await nextOutput(runtime, id, signal, deadline)
      }
    }
    if (!awaiting()) {
      return
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      await failNeverReady(start)
      return
    }
    let wait: RuntimeTerminalWait
    try {
      wait = await waitForWorkerAgentReady(runtime, terminalHandle, {
        ...start.readiness,
        timeoutMs: remaining,
        signal
      })
    } catch (error) {
      if (!awaiting()) {
        return
      }
      // Only time ran out (a screen a person must answer resolves the wait instead); else it failed.
      await (readinessStillPending({ error })
        ? failNeverReady(start)
        : start.fail(error, 'agent_readiness'))
      return
    }
    if (!awaiting()) {
      return
    }
    if (wait.satisfied) {
      db.recordWorkerStage({ dispatchId, stage: 'agent_readiness' })
      await start.handOver()
      return
    }
    if (!wait.blockedReason) {
      await start.fail(new Error(`Agent did not become ready (${wait.status}).`), 'agent_readiness')
      return
    }
    if (!blocked) {
      await reportBlockedWorkerStart(
        runtime,
        db,
        dispatchId,
        terminalHandle,
        wait.blockedReason,
        deadline
      )
    }
    blocked = wait.blockedReason
  }
}

/** Ten minutes on, the start fails once with what its screen shows; the terminal stays for a look. */
async function failNeverReady(start: AwaitingWorkerStart): Promise<void> {
  const { runtime, db, dispatchId, terminalHandle } = start
  const screen = await readWorkerStartScreen(runtime, terminalHandle)
  const worker = db.getWorkerDispatch(dispatchId)
  if (worker?.state !== 'starting' || worker.stage !== WORKER_AWAITING_AGENT_STAGE) {
    return
  }
  const ms = workerStartReadyDeadlineMs()
  const within = ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`
  const failed = db.failWorkerStart(
    dispatchId,
    'agent_readiness',
    `Its agent wasn't ready within ${within}, so Orca never typed its brief.`
  )
  reportNeverReadyWorkerStart(db, failed, screen, (handle, type) =>
    runtime.notifyMessageArrived(handle, type)
  )
}

/** Resolves on the pane's next output, an abort or the deadline, whichever is first. */
function nextOutput(
  runtime: Pick<OrcaRuntimeService, 'subscribeToTerminalData'>,
  ptyId: string,
  signal: AbortSignal,
  deadline: number
): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      unsubscribe()
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const unsubscribe = runtime.subscribeToTerminalData(ptyId, done)
    const timer = setTimeout(done, Math.max(0, deadline - Date.now()))
    signal.addEventListener('abort', done, { once: true })
  })
}

/** How a wait-for-setup pane's Setup ended, read from the sequencing lines its wrapper prints. */
function setupEnd(
  runtime: Pick<OrcaRuntimeService, 'subscribeToTerminalData' | 'readRecentTerminalOutput'>,
  ptyId: string,
  signal: AbortSignal
): Promise<'started' | 'failed' | 'aborted'> {
  const gate = createSetupWaitGate()
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null
    // The wrapper gives up by then itself; this only bounds a wait whose sequencing lines went unseen.
    const cap = setTimeout(() => finish('started'), SETUP_WAIT_GATE_MAX_MS)
    const finish = (phase: 'started' | 'failed' | 'aborted') => {
      clearTimeout(cap)
      unsubscribe?.()
      signal.removeEventListener('abort', onAbort)
      resolve(phase)
    }
    const onAbort = () => finish('aborted')
    const observe = (chunk: string): boolean => {
      const { phase } = gate.observe(chunk)
      if (phase === 'started' || phase === 'failed') {
        finish(phase)
        return true
      }
      return false
    }
    if (signal.aborted) {
      finish('aborted')
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // The wrapper's wait line printed before this wait began; its recent bytes still hold it.
    if (observe(runtime.readRecentTerminalOutput(ptyId) ?? '')) {
      return
    }
    unsubscribe = runtime.subscribeToTerminalData(ptyId, (data) => {
      observe(data)
    })
  })
}
