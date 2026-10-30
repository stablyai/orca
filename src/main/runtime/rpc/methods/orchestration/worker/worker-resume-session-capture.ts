import { isStructuredWorkerHandle } from '../../../../../../shared/structured-worker-handle'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { recordWorkerResumeSession } from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { orchestrationTimestampToMs } from './worker-output'

/** Save the terminal agent's conversation while its hook rows still name it; a closed worker reopens in it. */
export function captureWorkerResumeSession(
  runtime: Pick<OrcaRuntimeService, 'getExactWorkerProviderSession'>,
  db: OrchestrationDb,
  dispatchId: string
): void {
  const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
  const worker = db.getWorkerDispatch(dispatchId)
  if (!resource || !worker || isStructuredWorkerHandle(resource.terminal_handle)) {
    return
  }
  recordWorkerResumeSession(
    db,
    resource.id,
    runtime.getExactWorkerProviderSession(
      resource.terminal_handle,
      orchestrationTimestampToMs(worker.created_at)
    )
  )
}
