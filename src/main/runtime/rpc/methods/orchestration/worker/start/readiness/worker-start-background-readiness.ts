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
import type { SetupEndWatch } from './worker-setup-end-watch'
import { registerWorkerStartWait } from './worker-start-waits'
import { TUI_IDLE_QUIESCENCE_MS } from '../../../../../../terminal/wait/terminal-idle-policy'
import { WORKER_AWAITING_AGENT_STAGE } from '../../../../../../orchestration/db/worker-dispatch/worker-awaiting-agent-stage'

const READY_DEADLINE_MS = 10 * 60_000
const QUIET_READ_MARGIN_MS = 500

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

/** The PTY behind a waiting worker's pane: the one its launch created, else whatever backs the handle now. */
export function workerPanePtyId(
  runtime: Pick<OrcaRuntimeService, 'getTerminalPtyIdForHandle'>,
  handle: string,
  readiness: WorkerReadinessWaitArgs
): string | null {
  return (
    (!readiness.reusesTerminal && freshLaunchPtyId(handle, readiness.creation)) ||
    runtime.getTerminalPtyIdForHandle(handle)
  )
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
  /** A wait-for-setup launch's watch for Setup's end, kept from launch; the wait owns it from here. */
  setupEnd?: SetupEndWatch | null
  blockedReason?: RuntimeTerminalWaitBlockedReason
  /** Types the brief and settles the start, as a start ready in time does. */
  handOver: (ready: RuntimeTerminalWait) => Promise<void>
  /** Records the terminal as this worker's own, as a hand-over does first. */
  bindTerminal: () => void
  /** Fails the start as the caller's own failure would. */
  fail: (error: unknown, failedStage: string) => Promise<void>
}

/** Moves the start to its awaiting stage and watches on; the caller returns at once. */
export function awaitWorkerAgentInBackground(start: AwaitingWorkerStart): {
  readyBy: number | null
} {
  // A screen already up means the agent runs, so Setup is over.
  const setupEnd = start.blockedReason ? null : (start.setupEnd ?? null)
  if (!setupEnd) {
    start.setupEnd?.dispose()
  }
  const clock = readyClock(setupEnd, start.launchedAt)
  try {
    start.db.recordWorkerStage({ dispatchId: start.dispatchId, stage: WORKER_AWAITING_AGENT_STAGE })
  } catch (error) {
    clock.dispose()
    throw error
  }
  registerWorkerStartWait(start.dispatchId, (signal) =>
    watch(start, signal, clock).catch((error: unknown) => {
      console.warn('[orchestration] waiting for a worker agent failed', start.dispatchId, error)
    })
  )
  // A launch still behind Setup has its clock start when Setup ends, so no time can be promised yet;
  // one whose Setup failed is ending now.
  const setupEnded = setupEnd?.ended()
  return { readyBy: setupEnd && (!setupEnded || setupEnded.failed) ? null : clock.readyBy() }
}

async function watch(start: AwaitingWorkerStart, signal: AbortSignal, clock: ReadyClock) {
  const { runtime, db, dispatchId, terminalHandle } = start
  const awaiting = () => {
    const worker = db.getWorkerDispatch(dispatchId)
    return (
      !signal.aborted &&
      worker?.state === 'starting' &&
      worker.stage === WORKER_AWAITING_AGENT_STAGE
    )
  }
  const ptyId = () => workerPanePtyId(runtime, terminalHandle, start.readiness)
  // The clock ran out, or Setup failed and no agent will start: either way the start ends here.
  const expire = async () => {
    await (clock.setupFailed()
      ? start.fail(new Error('Setup failed, so its agent never started.'), 'setup_wait')
      : failNeverReady(start))
  }
  try {
    let blocked = start.blockedReason
    if (blocked) {
      await reportBlockedWorkerStart(
        runtime,
        db,
        dispatchId,
        terminalHandle,
        blocked,
        clock.readyBy()
      )
    }
    for (;;) {
      if (blocked) {
        // A screen only a person answers changes only when they do: each repaint gets one tail read,
        // and the full wait starts again only once that screen is gone. Armed before each check, so
        // a repaint during the check (or the report before it) is not missed. An answered screen
        // reads as gone only once the pane is quiet, so the last repaint (or one during the report
        // above) is read once more then.
        let quietReadOwed = true
        while (awaiting() && !clock.expired.aborted) {
          const checked = new AbortController()
          const quiet = new AbortController()
          const quietTimer = quietReadOwed
            ? setTimeout(() => quiet.abort(), TUI_IDLE_QUIESCENCE_MS + QUIET_READ_MARGIN_MS)
            : undefined
          const repaint = nextOutput(
            runtime,
            terminalHandle,
            ptyId(),
            AbortSignal.any([signal, checked.signal, clock.expired, quiet.signal])
          )
          const gone = !(await stillBlocked(start))
          if (gone) {
            checked.abort()
          }
          await repaint
          clearTimeout(quietTimer)
          if (gone) {
            break
          }
          quietReadOwed = !quiet.signal.aborted
        }
      }
      if (!awaiting()) {
        return
      }
      if (clock.expired.aborted) {
        await expire()
        return
      }
      let wait: RuntimeTerminalWait
      try {
        wait = await waitForWorkerAgentReady(runtime, terminalHandle, {
          ...start.readiness,
          timeoutMs: SETUP_WAIT_GATE_MAX_MS + workerStartReadyDeadlineMs(),
          signal: AbortSignal.any([signal, clock.expired])
        })
      } catch (error) {
        if (!awaiting()) {
          return
        }
        // Time ran out (a screen a person must answer resolves the wait instead); else it failed.
        await (clock.expired.aborted || readinessStillPending({ error })
          ? expire()
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
        await start.fail(
          new Error(`Agent did not become ready (${wait.status}).`),
          'agent_readiness'
        )
        return
      }
      if (!blocked) {
        await reportBlockedWorkerStart(
          runtime,
          db,
          dispatchId,
          terminalHandle,
          wait.blockedReason,
          clock.readyBy()
        )
      }
      blocked = wait.blockedReason
    }
  } finally {
    clock.dispose()
  }
}

type ReadyClock = {
  /** Aborts when the deadline passes, or when Setup fails. */
  expired: AbortSignal
  setupFailed: () => boolean
  /** The deadline; while Setup runs, the latest it could be. */
  readyBy: () => number
  dispose: () => void
}

/** Runs from launch, or for a launch behind Setup from the moment its wrapper printed that Setup
 *  ended; until then only the wrapper's own 2-hour limit bounds it. */
function readyClock(setupEnd: SetupEndWatch | null, launchedAt: number): ReadyClock {
  const expire = new AbortController()
  let deadline = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let failed = false
  const arm = (at: number): void => {
    deadline = at
    clearTimeout(timer)
    timer = setTimeout(() => expire.abort(), Math.max(0, at - Date.now()))
  }
  if (!setupEnd) {
    arm(launchedAt + workerStartReadyDeadlineMs())
  } else {
    arm(Date.now() + SETUP_WAIT_GATE_MAX_MS + workerStartReadyDeadlineMs())
    setupEnd.onEnd((end) => {
      if (end.failed) {
        failed = true
        expire.abort()
      } else {
        arm(end.at + workerStartReadyDeadlineMs())
      }
    })
  }
  return {
    expired: expire.signal,
    setupFailed: () => failed,
    readyBy: () => deadline,
    dispose: () => {
      clearTimeout(timer)
      setupEnd?.dispose()
    }
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
  // The terminal stays open, so worker-release must find it as this worker's to close it.
  try {
    start.bindTerminal()
  } catch (error) {
    console.warn('[orchestration] could not bind a never-ready worker terminal', dispatchId, error)
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

/** Resolves on the pane's next output, its exit or an abort, whichever is first. */
function nextOutput(
  runtime: Pick<OrcaRuntimeService, 'subscribeToTerminalData' | 'waitForTerminal'>,
  handle: string,
  ptyId: string | null,
  signal: AbortSignal
): Promise<void> {
  const stop = new AbortController()
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const unsubscribe = ptyId ? runtime.subscribeToTerminalData(ptyId, () => resolve()) : () => {}
    signal.addEventListener('abort', () => resolve(), { once: true, signal: stop.signal })
    runtime.waitForTerminal(handle, { condition: 'exit', signal: stop.signal }).then(
      () => resolve(),
      () => resolve()
    )
    stop.signal.addEventListener('abort', () => unsubscribe())
  }).finally(() => stop.abort())
}
