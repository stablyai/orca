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
  const resolveWorker = () =>
    terminal.paneKeys
      .map((paneKey) => resolveTerminalWorkerDispatch(resolution, paneKey))
      .find((found) => found)
  const worker = resolveWorker()
  if (!worker || !newestMessageId) {
    return
  }
  const dispatchId = workerTurnStopDispatchId(worker.target)
  const before = readWorkerPresence(worker.db, dispatchId)
  const screen = await deps.readScreen(terminal.handle)
  const after = readWorkerPresence(worker.db, dispatchId)
  const still = resolveWorker()
  // Submitted and seen to work or rest during the read, or its Dispatch closed: the alert is stale.
  if (
    after?.presence !== before?.presence ||
    after?.generation !== before?.generation ||
    !still ||
    workerTurnStopDispatchId(still.target) !== dispatchId
  ) {
    return
  }
  observeHeldMailNotice(
    worker.db,
    worker.target,
    { from: worker.handle, newestMessageId, screen },
    deps.reportDeps
  )
}
