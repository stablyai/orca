import { isStructuredWorkerHandle } from '../../../../shared/orchestration/workers/structured-worker-handle'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { RemoteDispatchAttachmentRow } from '../db/orchestration-records'
import { resolveStructuredWorkerIdentity } from '../terminal-authority/structured-sessions/structured-worker-authority'
import type { StructuredWorkerIdentity } from '../terminal-authority/structured-sessions/structured-worker-identity'

/** The chat session a coordinator on another computer runs here, with whether it is still the attached one. */
export function remoteChatWorkerOf(
  db: OrchestrationDb,
  attachment: Pick<RemoteDispatchAttachmentRow, 'dispatch_id' | 'terminal_handle'> | undefined
): { identity: StructuredWorkerIdentity; exact: boolean } | null {
  const handle = attachment?.terminal_handle
  const identity =
    handle && isStructuredWorkerHandle(handle) ? resolveStructuredWorkerIdentity(handle, db) : null
  if (!attachment || !identity) {
    return null
  }
  return {
    identity,
    exact: db.isRemoteAttachmentProcessCurrent({
      dispatchId: attachment.dispatch_id,
      paneKey: identity.paneKey,
      processIncarnation: identity.processIncarnation
    })
  }
}
