import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { rebindReusedStructuredWorker } from '../../../rpc/methods/orchestration/structured-workers/orchestration-structured-worker-session'
import { workerTabStampForDispatch } from './worker-tab-stamp-at-launch'

export async function prepareStartingWorkerTab(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  chat: boolean,
  params: Parameters<OrchestrationDb['prepareStartingWorkerAuthority']>[0]
): Promise<void> {
  db.prepareStartingWorkerAuthority(params)
  const stamp = workerTabStampForDispatch(db, params.dispatchId)
  if (chat) {
    const identity = rebindReusedStructuredWorker(params.handle, db)
    if (identity && stamp && params.worktreeId) {
      await runtime.rebindWorkerChatTab(params.worktreeId, identity.sessionId, stamp.origin)
    }
  } else if (stamp && params.paneKey) {
    await runtime.rebindWorkerTerminalTab(params.paneKey, stamp.origin)
  }
}
