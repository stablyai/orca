import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/types'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import type { inspectRemoteAttachment } from './federation-attachment-observation'

export function remoteAttachmentLeaseIsCurrent(
  runtime: OrcaRuntimeService,
  attachment: RemoteDispatchAttachmentRow,
  observation: Awaited<ReturnType<typeof inspectRemoteAttachment>>,
  resource: WorkerTerminalResourceRow
): boolean {
  const db = runtime.getOrchestrationDb()
  return Boolean(
    observation.exact &&
    observation.terminal &&
    attachment.terminal_handle === resource.terminal_handle &&
    resource.owner_dispatch_id === attachment.dispatch_id &&
    resource.ownership_state === 'owned' &&
    (observation.terminal.handle === resource.terminal_handle ||
      resource.host_scope ===
        JSON.stringify(
          runtime.getOrchestrationDispatchAuthority(observation.terminal.handle)?.hostScope
        )) &&
    db.isRemoteAttachmentProcessCurrent({
      dispatchId: attachment.dispatch_id,
      paneKey: runtime.getTerminalPaneKey(observation.terminal.handle),
      processIncarnation: runtime.getTerminalProcessIncarnation(observation.terminal.handle)
    }) &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}
