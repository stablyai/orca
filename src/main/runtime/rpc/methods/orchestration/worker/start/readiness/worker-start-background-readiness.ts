import type { TuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent'
import { SETUP_WAIT_GATE_MAX_MS } from '../../../../../../../../shared/agent-launch/startup/setup-wait-output-gate'
import {
  SETUP_COMPLETE_MESSAGE,
  SETUP_FAILED_MESSAGE_PREFIX,
  SETUP_WAIT_TIMEOUT_MESSAGE
} from '../../../../../../../../shared/agent-launch/startup/setup-agent-sequencing'
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
  const gated =
    start.setup.startupPolicy === 'wait-for-setup' &&
    start.setup.state === 'running' &&
    !start.blockedReason
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
  const clock = readyClock(runtime, gated ? ptyId() : null, start.launchedAt)
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
        // a repaint during the check (or the report before it) is not missed.
        while (awaiting() && !clock.expired.aborted) {
          const checked = new AbortController()
          const repaint = nextOutput(
            runtime,
            terminalHandle,
            ptyId(),
            AbortSignal.any([signal, checked.signal, clock.expired])
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

const SETUP_END_LINES = [
  { line: SETUP_COMPLETE_MESSAGE, failed: false },
  { line: SETUP_FAILED_MESSAGE_PREFIX, failed: true },
  { line: SETUP_WAIT_TIMEOUT_MESSAGE, failed: true }
] as const
const SETUP_END_CARRY = Math.max(...SETUP_END_LINES.map(({ line }) => line.length)) - 1

/** Runs from launch, or for a wait-for-setup pane (`setupPtyId`) from the line its wrapper prints in
 *  that pane when Setup ends; until then only the wrapper's own 2-hour limit bounds it. */
function readyClock(
  runtime: Pick<OrcaRuntimeService, 'subscribeToTerminalData' | 'readRecentTerminalOutput'>,
  setupPtyId: string | null,
  launchedAt: number
): ReadyClock {
  const expire = new AbortController()
  let deadline = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let failed = false
  let unsubscribe = (): void => {}
  const arm = (at: number): void => {
    deadline = at
    clearTimeout(timer)
    timer = setTimeout(() => expire.abort(), Math.max(0, at - Date.now()))
  }
  if (!setupPtyId) {
    arm(launchedAt + workerStartReadyDeadlineMs())
  } else {
    arm(Date.now() + SETUP_WAIT_GATE_MAX_MS + workerStartReadyDeadlineMs())
    let carry = ''
    let ended = false
    const scan = (chunk: string): void => {
      const window = carry + chunk
      carry = window.slice(-SETUP_END_CARRY)
      const end = ended ? undefined : SETUP_END_LINES.find(({ line }) => window.includes(line))
      if (!end) {
        return
      }
      ended = true
      unsubscribe()
      if (end.failed) {
        failed = true
        expire.abort()
      } else {
        arm(Date.now() + workerStartReadyDeadlineMs())
      }
    }
    unsubscribe = runtime.subscribeToTerminalData(setupPtyId, scan)
    // The line may have come before this wait began; the pane's recent bytes still hold it.
    scan(runtime.readRecentTerminalOutput(setupPtyId) ?? '')
  }
  return {
    expired: expire.signal,
    setupFailed: () => failed,
    readyBy: () => deadline,
    dispose: () => {
      clearTimeout(timer)
      unsubscribe()
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
