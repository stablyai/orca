import type { OrchestrationDb } from '../../db/orchestration-db'
import type { SleptMailboxWake } from './slept-mailbox-wake'
import {
  RUN_PANE_KEY_MATCH_SUFFIX_SQL,
  DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL,
  REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL,
  paneKeyMatchSuffix,
  isEquivalentPaneKey
} from '../../db/pane-key-match'
import { potentiallyLiveRemoteAttachmentSql } from '../../db/federation/remote-attachment-liveness'

/** Current authority ranges lead exact inbox seeks, including old Runs still bound to this owner. */
export function sleepingMailOwnerMailboxes(
  db: OrchestrationDb,
  pane: string,
  visited = new Set<string>()
): string[] {
  const suffix = paneKeyMatchSuffix(pane)
  const remoteLive = `${potentiallyLiveRemoteAttachmentSql()}
    AND NOT EXISTS (SELECT 1 FROM dispatch_contexts WHERE id = remote_dispatch_attachments.dispatch_id)`
  const branches = [
    {
      table: 'runs',
      index: 'idx_runs_coordinator_pane_leaf',
      key: RUN_PANE_KEY_MATCH_SUFFIX_SQL,
      id: 'id',
      owner: 'coordinator_pane_key',
      live: 'coordinator_pane_key IS NOT NULL'
    },
    {
      table: 'dispatch_contexts',
      index: 'idx_dispatch_assignee_pane_leaf',
      key: DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL,
      id: 'id',
      owner: 'assignee_pane_key',
      live: "assignee_pane_key IS NOT NULL AND status IN ('pending', 'dispatched')"
    },
    {
      table: 'remote_dispatch_attachments',
      index: 'idx_remote_dispatch_attachments_active_pane_suffix',
      key: REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL,
      id: 'dispatch_id',
      owner: 'pane_key',
      live: `pane_key IS NOT NULL AND ${remoteLive}`
    }
  ]
  const found: string[] = []
  for (const branch of branches) {
    const prefix = branch.table === 'runs' ? 'run:' : 'dispatch:'
    // One statement per owner kind: the mail check runs inside SQLite, not once per owner row here.
    const rows = db.db
      .prepare(`SELECT '${prefix}' || ${branch.id} AS mailbox, ${branch.owner} AS owner
      FROM ${branch.table} INDEXED BY ${branch.index} WHERE ${branch.key} = ? AND ${branch.live}
        AND EXISTS (SELECT 1 FROM messages INDEXED BY idx_messages_mail_wake_candidate
          WHERE to_handle = '${prefix}' || ${branch.table}.${branch.id} AND read = 0
            AND delivered_at IS NULL AND pointer_enter_pending = 0
            AND delivery_contract = 'current_delivery')`)
      .all(suffix)
    for (const row of rows) {
      if (
        typeof row.mailbox !== 'string' ||
        typeof row.owner !== 'string' ||
        visited.has(row.mailbox) ||
        !isEquivalentPaneKey(pane, row.owner)
      ) {
        continue
      }
      visited.add(row.mailbox)
      found.push(row.mailbox)
    }
  }
  return found
}

/** A sleeping pane's own inboxes: its Runs, Dispatches and attachments with mail, plus the direct
 *  mailbox of the handle its sleep record saved (mail sent while it was going to sleep). */
function paneMailboxes(
  wake: SleptMailboxWake,
  db: OrchestrationDb,
  pane: string,
  directMailbox: (pane: string) => string | undefined,
  visited?: Set<string>
): string[] {
  if (!wake.hasObligation(pane)) {
    return []
  }
  const direct = directMailbox(pane)
  return [...sleepingMailOwnerMailboxes(db, pane, visited), ...(direct ? [direct] : [])]
}

/** Re-derives tracked mailboxes and every sleeping pane's own inboxes, returning those panes: the
 *  work is bounded by the sleeping panes, never by how much old mail the database holds. */
export function reconcileSleepingMail(
  wake: SleptMailboxWake,
  db: OrchestrationDb,
  panes: Iterable<string>,
  directMailbox: (pane: string) => string | undefined
): Set<string> {
  const affected = new Set(panes)
  const mailboxes = new Set(wake.trackedMailboxes())
  const visited = new Set(mailboxes)
  for (const pane of affected) {
    for (const mailbox of paneMailboxes(wake, db, pane, directMailbox, visited)) {
      mailboxes.add(mailbox)
    }
  }
  for (const mailbox of mailboxes) {
    wake.refresh(mailbox)
  }
  return affected
}

/** Refreshes only the named mailboxes and panes; returns every pane whose obligation may have moved. */
export function refreshSleepingMailScope(
  wake: SleptMailboxWake,
  db: OrchestrationDb,
  mailboxes: Iterable<string>,
  panes: Iterable<string>,
  directMailbox: (pane: string) => string | undefined
): Set<string> {
  const affected = new Set(panes)
  const named = new Set(mailboxes)
  for (const pane of affected) {
    for (const mailbox of [
      ...wake.mailboxesForPane(pane),
      ...paneMailboxes(wake, db, pane, directMailbox)
    ]) {
      named.add(mailbox)
    }
  }
  for (const mailbox of named) {
    for (const pane of wake.refresh(mailbox)) {
      affected.add(pane)
    }
  }
  return affected
}
