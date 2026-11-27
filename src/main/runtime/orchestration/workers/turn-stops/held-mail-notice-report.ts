import type { OrchestrationDb } from '../../db/orchestration-db'
import { readWorkerPresence } from '../../db/worker-presence/worker-presence-store'
import { resolveTerminalWorkerDispatch } from './terminal-worker-dispatch'
import { observeHeldMailNotice } from './unconfirmed-worker-start'
import { workerTurnStopDispatchId, type WorkerTurnStopReportDeps } from './worker-turn-stop-report'

/** Tells a terminal worker's coordinator, at home or across a paired server, once that a mailbox
 *  notice stayed in its prompt. */
export async function reportHeldMailNotice(
  deps: {
    getDb: () => OrchestrationDb | null
    getProcessIncarnation: (handle: string) => string | null
    readScreen: (handle: string) => Promise<string | undefined>
    reportDeps: WorkerTurnStopReportDeps
  },
  terminal: { handle: string; paneKeys: readonly string[] },
  messageIds: readonly string[]
): Promise<void> {
  const newestMessageId = messageIds.at(-1)
  const resolution = { ...deps, getHandle: () => terminal.handle }
  const worker = terminal.paneKeys
    .map((paneKey) => resolveTerminalWorkerDispatch(resolution, paneKey))
    .find((found) => found)
  if (!worker || !newestMessageId) {
    return
  }
  const dispatchId = workerTurnStopDispatchId(worker.target)
  const before = readWorkerPresence(worker.db, dispatchId)
  const screen = await deps.readScreen(terminal.handle)
  const after = readWorkerPresence(worker.db, dispatchId)
  // Submitted and seen to work or rest during the read: the alert would be stale.
  if (after?.presence !== before?.presence || after?.generation !== before?.generation) {
    return
  }
  observeHeldMailNotice(
    worker.db,
    worker.target,
    { from: worker.handle, newestMessageId, screen },
    deps.reportDeps
  )
}
