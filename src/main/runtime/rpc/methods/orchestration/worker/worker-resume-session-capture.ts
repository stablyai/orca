import { isStructuredWorkerHandle } from '../../../../../../shared/structured-worker-handle'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  findHeldWorkerResourceForPane,
  recordWorkerResumeSession
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import { orchestrationTimestampToMs } from './worker-output'

/** Save the terminal agent's conversation while its hook rows still name it: at its report, and before stop or release closes it. */
export function captureWorkerResumeSession(
  runtime: Pick<OrcaRuntimeService, 'getExactWorkerProviderSession'>,
  db: OrchestrationDb,
  resource: Pick<WorkerTerminalResourceRow, 'id' | 'terminal_handle'>,
  attachedAtMs: number
): void {
  if (isStructuredWorkerHandle(resource.terminal_handle)) {
    return
  }
  recordWorkerResumeSession(
    db,
    resource.id,
    runtime.getExactWorkerProviderSession(resource.terminal_handle, attachedAtMs)
  )
}

/** The worker_done edge: its Dispatch's resource and attach time, read from the settled rows. */
export function captureReportedWorkerResumeSession(
  runtime: Pick<OrcaRuntimeService, 'getExactWorkerProviderSession'>,
  db: OrchestrationDb,
  dispatchId: string
): void {
  const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
  const worker = db.getWorkerDispatch(dispatchId)
  if (resource && worker) {
    captureWorkerResumeSession(runtime, db, resource, orchestrationTimestampToMs(worker.created_at))
  }
}

/** A `/clear` or resumed session in a worker's pane: keep its newest conversation as it moves. */
export function watchMovedWorkerResumeSessions(
  runtime: Pick<OrcaRuntimeService, 'getExactWorkerProviderSession'>,
  getDb: () => OrchestrationDb | null
): (sessions: readonly { paneKey: string; sessionId: string }[]) => void {
  // Each notification lists every pane; only a pane whose conversation changed needs saving.
  let seen = new Map<string, string>()
  return (sessions) => {
    const db = getDb()
    const moved = sessions.filter(({ paneKey, sessionId }) => seen.get(paneKey) !== sessionId)
    seen = new Map(sessions.map(({ paneKey, sessionId }) => [paneKey, sessionId]))
    for (const { paneKey } of db ? moved : []) {
      const owner = db && findHeldWorkerResourceForPane(db, paneKey)?.owner_dispatch_id
      if (db && owner) {
        captureReportedWorkerResumeSession(runtime, db, owner)
      }
    }
  }
}
