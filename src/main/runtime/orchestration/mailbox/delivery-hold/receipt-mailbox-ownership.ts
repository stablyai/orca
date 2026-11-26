import type { OrchestrationDb } from '../../db/orchestration-db'
import { isEquivalentPaneKey } from '../../db/pane-key-match'
import type { OrchestrationMailboxTerminal } from '../routing/mailbox-owner'
import type { MailboxDeliveryHold } from './mailbox-delivery-hold'

/** Whether the terminal delivery found for a mailbox reads it, in the owner's precedence (bound Run,
 *  then local Dispatch, then remote attachment), but with one-row reads instead of the owner's full
 *  list of Runs bound to the pane: a receipt runs on every send. Null when the terminal reads it. */
export function receiptMailboxOwnershipHold(
  db: OrchestrationDb,
  terminal: Pick<OrchestrationMailboxTerminal, 'handle' | 'paneKeys'>,
  mailbox: string
): MailboxDeliveryHold | null {
  const { handle, paneKeys } = terminal
  const notRead = (reads: string | null): MailboxDeliveryHold => ({
    kind: 'not-read',
    terminal: handle,
    reads
  })
  if (mailbox.startsWith('run:')) {
    const run = db.getRun(mailbox.slice('run:'.length))
    const runPane = run && !run.legacy ? run.coordinator_pane_key : null
    const bound = !!runPane && paneKeys.some((paneKey) => isEquivalentPaneKey(runPane, paneKey))
    return bound ? null : notRead(currentMailbox(db, terminal))
  }
  if (mailbox.startsWith('dispatch:')) {
    const reads = currentMailbox(db, terminal)
    return reads === mailbox ? null : notRead(reads)
  }
  // Send routing moved direct mail for a pane with a local Run or Dispatch to that mailbox; a
  // remote-attached pane reads only its Task's mail, so direct mail stays unread there.
  return paneKeys.some((paneKey) => db.findActiveRemoteAttachmentForPane(paneKey))
    ? { kind: 'unreachable', terminal: handle }
    : null
}

/** The mailbox a terminal's own check reads now, which mail to its handle reaches; null when it is
 *  remote-attached, whose Task mailbox only its home writes. */
function currentMailbox(
  db: OrchestrationDb,
  terminal: Pick<OrchestrationMailboxTerminal, 'handle' | 'paneKeys'>
): string | null {
  const { handle, paneKeys } = terminal
  for (const paneKey of paneKeys) {
    const run = db.getCurrentRunForPane(paneKey)
    if (run) {
      return `run:${run.id}`
    }
  }
  for (const paneKey of paneKeys) {
    const dispatch = db.getActiveDispatchForIdentity(handle, paneKey)
    if (dispatch) {
      return `dispatch:${dispatch.id}`
    }
  }
  return paneKeys.some((paneKey) => db.findActiveRemoteAttachmentForPane(paneKey)) ? null : handle
}
