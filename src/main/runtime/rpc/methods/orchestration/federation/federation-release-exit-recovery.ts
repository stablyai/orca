import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/types'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import { summarizeWorkerOutputArchive } from '../../../../orchestration/worker-output-archive'
import type { WorkerReleaseReceipt } from '../worker/worker-release-completion'

/** A lost close acknowledgement can settle only from host exit proof and a committed archive. */
export async function recoverExitedFederationRelease(
  runtime: OrcaRuntimeService,
  attachment: RemoteDispatchAttachmentRow,
  resource: WorkerTerminalResourceRow
): Promise<WorkerReleaseReceipt | null> {
  const db = runtime.getOrchestrationDb()
  const archive = db.getWorkerTerminalArchive(attachment.dispatch_id)
  if (
    !archive ||
    archive.resource_id !== resource.id ||
    !resource.process_incarnation ||
    resource.process_incarnation !== attachment.process_incarnation
  ) {
    return null
  }
  const verdict = await runtime.inspectTerminalProcessIncarnationLiveness(
    resource.process_incarnation,
    resource.host_scope
  )
  if (verdict !== 'exited') {
    return null
  }
  const current = db.getWorkerTerminalResourceByOwner(attachment.dispatch_id)
  if (
    current?.id !== resource.id ||
    current.process_incarnation !== resource.process_incarnation ||
    current.host_scope !== resource.host_scope ||
    current.ownership_state !== 'owned' ||
    db.workerTerminalResourceHasIdentityConflict(resource.id)
  ) {
    return null
  }
  const summary = summarizeWorkerOutputArchive(archive)
  const releasing = db.commitWorkerTerminalArchiveForRelease({
    dispatchId: attachment.dispatch_id,
    resourceId: resource.id,
    archiveSource: summary.source,
    archiveStatus: summary.status
  })
  if (releasing.ownership_state !== 'owned' || releasing.release_state !== 'releasing') {
    return null
  }
  db.settleWorkerTerminalRelease(resource.id)
  db.recordRemoteAttachmentStage({ dispatchId: attachment.dispatch_id, stage: 'released' })
  return {
    dispatchId: attachment.dispatch_id,
    state: 'released',
    processAction: 'closed_exited_terminal',
    archive: summary
  }
}
