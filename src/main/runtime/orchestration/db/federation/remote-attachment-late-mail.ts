import { ORCHESTRATION_FEDERATION_FOLLOW_UP_PROTOCOL_VERSION } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { OrchestrationDb } from '../orchestration-db'
import type { RemoteDispatchAttachmentRow } from '../orchestration-records'
import { DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL, paneKeyMatchSuffix } from '../pane-key-match'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

/** This host still holds the worker in its terminal: its custody is unreleased and no later Dispatch, local or
 *  remote, was assigned the terminal. A user's own terminal keeps its custody row across reuse, so both count. */
export function remoteAttachmentRetainsWorker(
  db: OrchestrationDb,
  attachment: RemoteDispatchAttachmentRow
): boolean {
  const resource = db.getWorkerTerminalResourceByOwner(attachment.dispatch_id)
  const paneKey = attachment.pane_key
  if (
    !paneKey ||
    attachment.stage === 'released' ||
    !resource ||
    resource.ownership_state === 'released' ||
    resource.release_state === 'released' ||
    db.findLatestRemoteAttachmentForPane(paneKey)?.dispatch_id !== attachment.dispatch_id
  ) {
    return false
  }
  return !localDispatchAssignedSince(db, resource.terminal_handle, paneKey, attachment.created_at)
}

// Any identity the terminal had: its handle can remint while its stable pane stays.
const LOCAL_ASSIGNED_SINCE_SQL = `SELECT 1 FROM dispatch_contexts
  WHERE created_at >= ?
    AND (assignee_handle = ? OR assignee_pane_key = ?
      OR (assignee_pane_key IS NOT NULL AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?))
  LIMIT 1`

/** Same-second ties count as later: losing a late note beats delivering another Dispatch's mail. */
function localDispatchAssignedSince(
  db: OrchestrationDb,
  handle: string,
  paneKey: string,
  since: string
): boolean {
  const suffix = parsePaneKey(paneKey) ? paneKeyMatchSuffix(paneKey) : null
  return Boolean(db.db.prepare(LOCAL_ASSIGNED_SINCE_SQL).get(since, handle, paneKey, suffix))
}

/** A finished remote worker still talks to its Run home while this host retains it, as a finished local
 *  worker does; only a Run home that keeps pulling for it gets the protocol version that allows it. */
export function remoteAttachmentTakesLateMail(
  db: OrchestrationDb,
  attachment: RemoteDispatchAttachmentRow
): boolean {
  return (
    attachment.protocol_version >= ORCHESTRATION_FEDERATION_FOLLOW_UP_PROTOCOL_VERSION &&
    (attachment.state === 'succeeded' || attachment.state === 'failed') &&
    remoteAttachmentRetainsWorker(db, attachment)
  )
}

/** The finished remote Dispatch this exact process may still mail or ask home about. */
export function findFinishedRemoteWorkerAttachment(
  db: OrchestrationDb,
  paneKey: string | undefined,
  processIncarnation: string | undefined
): RemoteDispatchAttachmentRow | undefined {
  const attachment = paneKey ? db.findLatestRemoteAttachmentForPane(paneKey) : undefined
  return attachment &&
    remoteAttachmentTakesLateMail(db, attachment) &&
    db.isRemoteAttachmentProcessCurrent({
      dispatchId: attachment.dispatch_id,
      paneKey: paneKey ?? null,
      processIncarnation: processIncarnation ?? null
    })
    ? attachment
    : undefined
}
