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
    const rows = db.db
      .prepare(`SELECT '${prefix}' || ${branch.id} AS mailbox, ${branch.owner} AS owner
      FROM ${branch.table} INDEXED BY ${branch.index} WHERE ${branch.key} = ? AND ${branch.live}`)
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
      if (
        db.db
          .prepare(`SELECT EXISTS (
        SELECT 1 FROM messages INDEXED BY idx_messages_mail_wake_candidate
        WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL AND pointer_enter_pending = 0
          AND delivery_contract = 'current_delivery'
      ) AS eligible`)
          .get(row.mailbox)?.eligible === 1
      ) {
        found.push(row.mailbox)
      }
    }
  }
  return found
}

/** Re-derives tracked mailboxes and every mailbox holding mail a wake could deliver: the work
 *  follows outstanding mail, not the number of sleeping panes or their Run history. */
export function reconcileSleepingMail(wake: SleptMailboxWake, db: OrchestrationDb): void {
  const mailboxes = new Set(wake.trackedMailboxes())
  const rows = db.db
    .prepare(`SELECT DISTINCT to_handle AS mailbox FROM messages
      INDEXED BY idx_messages_mail_wake_candidate
      WHERE read = 0 AND delivered_at IS NULL AND pointer_enter_pending = 0
        AND delivery_contract = 'current_delivery'`)
    .all()
  for (const row of rows) {
    if (typeof row.mailbox === 'string') {
      mailboxes.add(row.mailbox)
    }
  }
  for (const mailbox of mailboxes) {
    wake.refresh(mailbox)
  }
}

/** Refreshes only the named mailboxes and panes; returns every pane whose obligation may have moved. */
export function refreshSleepingMailScope(
  wake: SleptMailboxWake,
  db: OrchestrationDb,
  mailboxes: Iterable<string>,
  panes: Iterable<string>
): Set<string> {
  const affected = new Set(panes)
  const named = new Set(mailboxes)
  for (const pane of affected) {
    for (const mailbox of [
      ...wake.mailboxesForPane(pane),
      ...(wake.hasObligation(pane) ? sleepingMailOwnerMailboxes(db, pane) : [])
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
