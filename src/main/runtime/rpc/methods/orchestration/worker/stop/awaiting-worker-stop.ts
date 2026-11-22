import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'

/** Stops a start still waiting on its agent. Nothing was typed and no worker identity was bound yet,
 *  so the terminal this start created is closed by its custody alone; a reused one is left as is. */
export async function stopAwaitingWorker(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  handle: string
) {
  const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
  const owned = resource?.ownership_state === 'owned' && resource.terminal_handle === handle
  const closed = owned
    ? await runtime.closeTerminal(handle).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error)
      }))
    : null
  // A concurrent exit already settled it.
  if (db.getWorkerDispatch(dispatchId)?.state !== 'stopped') {
    if (closed && ('error' in closed || !closed.ptyKilled)) {
      const reason =
        'error' in closed
          ? closed.error
          : 'Its terminal closed, but the agent was not proven stopped.'
      const worker = db.markWorkerStopUnknown(dispatchId, reason)
      return {
        dispatchId,
        state: worker.state,
        alreadySettled: false,
        processAction: 'unknown' as const,
        lastError: reason
      }
    }
    db.settleWorkerStop(dispatchId)
  }
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    state: db.getWorkerDispatch(dispatchId)?.state ?? 'stopped',
    alreadySettled: false,
    processAction: closed ? ('closed_agent_terminal' as const) : ('none' as const)
  }
}
