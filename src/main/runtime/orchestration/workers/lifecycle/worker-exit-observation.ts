import type { OrchestrationDb } from '../../db/orchestration-db'
import type { WorkerDispatchRow } from '../../db/orchestration-records'
import { observeWorker, type WorkerGone } from '../turn-stops/worker-presence-report'
import type { WorkerTurnStopReportDeps } from '../turn-stops/worker-turn-stop-report'

type WorkerState = WorkerDispatchRow['state'] | undefined

/** The coordinator asked for a stop: the worker going away is what it asked for. */
export function isWorkerStopRequested(state: WorkerState): boolean {
  return state === 'stopping' || state === 'stop_unknown'
}

/** A start still being decided reports its own outcome; a stop the coordinator asked for is no news. */
export function isWorkerStartOrStopUndecided(state: WorkerState): boolean {
  return state === 'starting' || state === 'start_unknown' || isWorkerStopRequested(state)
}

export type TerminalWorkerExit = {
  handle: string
  paneKey: string | undefined
  /** The ended process; another one in the same pane is another worker life. */
  processIncarnation: string | null
  error: string
  options: Parameters<OrchestrationDb['failDispatch']>[2]
  processExited: boolean
  gone: Omit<WorkerGone, 'from'>
}

/** A terminal worker ended or was lost: its Dispatch fails, and the coordinator hears so in the same
 *  transaction. Returns whether the surface had an active Dispatch. */
export function observeTerminalWorkerExit(
  db: OrchestrationDb,
  runtimeId: string,
  exit: TerminalWorkerExit,
  deps: WorkerTurnStopReportDeps
): boolean {
  // Pane identity survives handle reminting.
  const dispatch = db.getActiveDispatchForTerminal(exit.handle, exit.paneKey)
  if (!dispatch) {
    return false
  }
  // Only this runtime's in-flight stop claims the outcome; durable stopping rows from a crashed runtime cannot absorb later failures.
  const state = db.getWorkerDispatch?.(dispatch.id)
  if (state?.state === 'stopping' && state.runtime_epoch === runtimeId) {
    if (exit.processExited) {
      db.settleWorkerStop(dispatch.id)
    }
    return true
  }
  // A stop asked for earlier (unconfirmed, or by a runtime before a restart) settles the Dispatch as failed, but sends no mail.
  if (isWorkerStopRequested(state?.state)) {
    db.failDispatch(dispatch.id, exit.error, exit.options)
    return true
  }
  observeWorker(
    db,
    { kind: 'local', dispatch },
    {
      presence: 'gone',
      fence: exit.processIncarnation ?? exit.handle,
      legacyStopKey: 'gone',
      gone: { from: exit.handle, ...exit.gone },
      settle: () => {
        const settled = db.failDispatch(dispatch.id, exit.error, exit.options)?.status
        return settled === 'failed' || settled === 'circuit_broken' ? settled : undefined
      }
    },
    deps
  )
  return true
}

/** A paired server's worker has no local Dispatch; any exit it did not report reaches the Run home through the stop relay. */
export function observeRemoteWorkerExit(
  db: OrchestrationDb,
  exit: Pick<TerminalWorkerExit, 'handle' | 'processIncarnation' | 'gone'> & { paneKey: string },
  deps: WorkerTurnStopReportDeps
): void {
  const attachment = db.findActiveRemoteAttachmentForPane(exit.paneKey)
  // The coordinator's own worker-stop closes the terminal before it settles the attachment.
  if (
    !attachment ||
    isWorkerStopRequested(attachment.state) ||
    !db.isRemoteAttachmentProcessCurrent({
      dispatchId: attachment.dispatch_id,
      paneKey: exit.paneKey,
      processIncarnation: exit.processIncarnation
    })
  ) {
    return
  }
  observeWorker(
    db,
    { kind: 'remote', attachment },
    {
      presence: 'gone',
      fence: exit.processIncarnation ?? exit.handle,
      legacyStopKey: 'gone',
      gone: { from: exit.handle, ...exit.gone }
    },
    deps
  )
}
