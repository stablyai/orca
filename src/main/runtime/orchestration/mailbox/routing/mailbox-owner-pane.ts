import { POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES } from '../../db/federation/remote-attachment-liveness'
import type { OrchestrationDb } from '../../db/orchestration-db'

/** The pane key a Run or Dispatch mailbox's owner was recorded under. */
export function mailboxOwnerPane(db: OrchestrationDb, mailbox: string): string | null {
  if (mailbox.startsWith('run:')) {
    return db.getRun(mailbox.slice(4))?.coordinator_pane_key ?? null
  }
  if (mailbox.startsWith('dispatch:')) {
    const id = mailbox.slice(9)
    const dispatch = db.getDispatchContextById(id)
    if (dispatch) {
      return dispatch.status === 'pending' || dispatch.status === 'dispatched'
        ? dispatch.assignee_pane_key
        : null
    }
    const attachment = db.getRemoteDispatchAttachment(id)
    return attachment &&
      POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES.some((state) => state === attachment.state)
      ? attachment.pane_key
      : null
  }
  return null
}
