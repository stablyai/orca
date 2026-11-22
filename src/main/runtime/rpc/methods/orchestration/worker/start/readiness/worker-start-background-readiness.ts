import type { TuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent'
import { SETUP_WAIT_GATE_MAX_MS } from '../../../../../../../../shared/agent-launch/startup/setup-wait-output-gate'
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

/** The deadline as a person reads it. */
export function deadlineText(): string {
  const ms = workerStartReadyDeadlineMs()
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`
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
  /** The wait-for-setup pane's Setup terminal while Setup still runs; its end starts the clock. */
  setupTerminal?: string
  /** Types the brief and settles the start, as a start ready in time does. */
  handOver: (ready: RuntimeTerminalWait) => Promise<void>
  /** Fails the start as the caller's own failure would. */
  fail: (error: unknown, failedStage: string) => Promise<void>
}

/** Moves the start to its awaiting stage and watches on; the caller returns at once. */
export function awaitWorkerAgentInBackground(start: AwaitingWorkerStart): {
  readyBy: number | null
} {
  start.db.recordWorkerStage({ dispatchId: start.dispatchId, stage: WORKER_AWAITING_AGENT_STAGE })
  const controller = new AbortController()
  waits.get(start.dispatchId)?.abort()
  waits.set(start.dispatchId, controller)
  // A screen already up means the agent runs, so Setup is over.
  const gated = start.setupTerminal !== undefined && !start.blockedReason
  void watch(start, controller.signal, gated)
    .catch((error: unknown) => {
      console.warn('[orchestration] waiting for a worker agent failed', start.dispatchId, error)
    })
    .finally(() => {
      if (waits.get(start.dispatchId) === controller) {
        waits.delete(start.dispatchId)
      }
    })
  // A gated launch's clock starts when Setup ends, so no time can be promised yet.
  return { readyBy: gated ? null : start.launchedAt + workerStartReadyDeadlineMs() }
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
  if (gated && start.setupTerminal) {
    const setup = await setupEnd(runtime, start.setupTerminal, signal)
    if (!awaiting()) {
      return
    }
    if (setup === 'failed') {
      await start.fail(new Error('Setup failed, so its agent never started.'), 'setup_wait')
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
      // A screen only a person answers changes only when they do: each repaint gets one tail read,
      // and the full wait starts again only once that screen is gone.
      // Armed before each check, so a repaint during the check (or the report before it) is not missed.
      while (awaiting() && Date.now() < deadline) {
        const checked = new AbortController()
        const repaint = nextOutput(
          runtime,
          terminalHandle,
          ptyId(),
          AbortSignal.any([signal, checked.signal]),
          deadline
        )
        if (!(await stillBlocked(start))) {
          checked.abort()
          await repaint
          break
        }
        await repaint
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
      await start.handOver(wait)
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
  const failed = db.failWorkerStart(
    dispatchId,
    'agent_readiness',
    `Its agent wasn't ready within ${deadlineText()}, so Orca never typed its brief.`
  )
  reportNeverReadyWorkerStart(db, failed, screen, (handle, type) =>
    runtime.notifyMessageArrived(handle, type)
  )
}

/** Whether the pane still shows a screen only a person can answer: one tail read, no waiter kept. */
async function stillBlocked({ runtime, terminalHandle }: AwaitingWorkerStart): Promise<boolean> {
  const probe = await runtime
    .waitForTerminal(terminalHandle, { condition: 'tui-idle', launchReadiness: true, timeoutMs: 1 })
    .catch(() => null)
  return probe?.satisfied === false && probe.blockedReason !== undefined
}

/** Resolves on the pane's next output, its exit, an abort or the deadline, whichever is first. */
function nextOutput(
  runtime: Pick<OrcaRuntimeService, 'subscribeToTerminalData' | 'waitForTerminal'>,
  handle: string,
  ptyId: string | null,
  signal: AbortSignal,
  deadline: number
): Promise<void> {
  const stop = new AbortController()
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const unsubscribe = ptyId ? runtime.subscribeToTerminalData(ptyId, () => resolve()) : () => {}
    const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))
    signal.addEventListener('abort', () => resolve(), { once: true, signal: stop.signal })
    runtime.waitForTerminal(handle, { condition: 'exit', signal: stop.signal }).then(
      () => resolve(),
      () => resolve()
    )
    stop.signal.addEventListener('abort', () => {
      unsubscribe()
      clearTimeout(timer)
    })
  }).finally(() => stop.abort())
}

/** How a wait-for-setup pane's Setup ended: by its own terminal's exit, as structured workers wait. */
async function setupEnd(
  runtime: Pick<OrcaRuntimeService, 'waitForSetupTerminalCompletion'>,
  setupTerminal: string,
  signal: AbortSignal
): Promise<'started' | 'failed' | 'aborted'> {
  const stop = new AbortController()
  const both = AbortSignal.any([signal, stop.signal])
  // The wrapper gives up by then itself, so no agent can start after it.
  const cap = setTimeout(() => stop.abort(), SETUP_WAIT_GATE_MAX_MS)
  try {
    const { exitCode } = await runtime.waitForSetupTerminalCompletion(setupTerminal, both)
    return exitCode === 0 ? 'started' : 'failed'
  } catch {
    // A Setup terminal already gone has ended; the readiness wait decides what came of it.
    return signal.aborted ? 'aborted' : 'started'
  } finally {
    clearTimeout(cap)
  }
}
