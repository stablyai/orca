import type { SleptMailboxWake } from './slept-mailbox-wake'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  RUN_PANE_KEY_MATCH_SUFFIX_SQL,
  DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL,
  REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL,
  paneKeyMatchSuffix,
  isEquivalentPaneKey
} from '../../db/pane-key-match'
import { potentiallyLiveRemoteAttachmentSql } from '../../db/federation/remote-attachment-liveness'
import { parseOrcaSessionAddress } from '../../../../../shared/orca-session-address'

/** Owner edits discover mail without enumerating unrelated unread mailboxes. */
export function sleepingMailOwnerMailboxes(
  db: OrchestrationDb,
  pane: string | null,
  address?: string
): string[] {
  const suffix = pane === null ? null : paneKeyMatchSuffix(pane)
  const sessionId = parseOrcaSessionAddress(address)
  const rows = db.db
    .prepare(`
    SELECT 'run:' || id AS mailbox, coordinator_pane_key AS owner FROM runs
      WHERE coordinator_pane_key IS NOT NULL AND ${RUN_PANE_KEY_MATCH_SUFFIX_SQL} = ?
    UNION SELECT 'dispatch:' || id AS mailbox, assignee_pane_key AS owner FROM dispatch_contexts
      WHERE assignee_pane_key IS NOT NULL AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?
        AND status IN ('pending', 'dispatched')
    UNION SELECT 'dispatch:' || dispatch_id AS mailbox, pane_key AS owner FROM remote_dispatch_attachments
      WHERE pane_key IS NOT NULL AND ${REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL} = ?
        AND ${potentiallyLiveRemoteAttachmentSql()}
    UNION SELECT 'run:' || id AS mailbox, NULL AS owner FROM runs WHERE coordinator_orca_session_id = ?
    UNION SELECT 'run:' || run_id AS mailbox, NULL AS owner FROM run_coordinator_handles WHERE terminal_handle = ?
    UNION SELECT 'dispatch:' || id AS mailbox, NULL AS owner FROM dispatch_contexts
      WHERE (assignee_handle = ? OR assignee_orca_session_id = ?)
        AND status IN ('pending', 'dispatched')
  `)
    .all(suffix, suffix, suffix, sessionId, address ?? null, address ?? null, sessionId)
  return rows.flatMap((row) =>
    typeof row.mailbox === 'string' &&
    (pane === null ||
      row.owner === null ||
      (typeof row.owner === 'string' && isEquivalentPaneKey(pane, row.owner)))
      ? [row.mailbox]
      : []
  )
}

export function refreshSleepingMailOwners(
  wake: SleptMailboxWake,
  db: OrchestrationDb,
  owners: Iterable<string>,
  addresses: Iterable<string>
): Set<string> {
  const affected = new Set(owners)
  const mailboxes = new Set(addresses)
  for (const pane of affected) {
    for (const mailbox of [...wake.mailboxesForPane(pane), ...wake.discover(pane)]) {
      mailboxes.add(mailbox)
    }
  }
  for (const address of addresses) {
    if (!address.startsWith('run:') && !address.startsWith('dispatch:')) {
      for (const mailbox of sleepingMailOwnerMailboxes(db, null, address)) {
        mailboxes.add(mailbox)
      }
    }
  }
  for (const mailbox of mailboxes) {
    for (const pane of wake.refresh(mailbox)) {
      affected.add(pane)
    }
  }
  return affected
}
