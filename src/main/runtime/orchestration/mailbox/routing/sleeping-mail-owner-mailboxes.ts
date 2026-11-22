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

/** The Runs, Dispatches and attachments this pane owns that hold mail, old Runs included. */
function sleepingMailOwnerMailboxes(
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

// Run and Dispatch mail reaches a sleeper on arrival, and after a restart through the restored-mail
// repoint, so re-checks walk a pane's owner history (which grows with every Run it created) only
// for the few panes holding a wake attempt, whose custody settles once that mail is taken.

/** A sleeping pane's inboxes to re-check: its saved handle's (mail sent while it went to sleep
 *  found no record to wake), and its owned Runs and Dispatches while it holds a wake attempt. */
export function sleepingPaneInboxes(
  db: OrchestrationDb | null,
  pane: string,
  savedHandle: string | undefined,
  holdsAttempt: boolean
): string[] {
  return [
    ...(savedHandle ? [savedHandle] : []),
    ...(holdsAttempt && db ? sleepingMailOwnerMailboxes(db, pane) : [])
  ]
}

function paneMailboxes(
  wake: SleptMailboxWake,
  pane: string,
  inboxes: (pane: string) => string[]
): string[] {
  return wake.hasObligation(pane) ? inboxes(pane) : []
}

/** Re-derives tracked and named mailboxes and each sleeping pane's inboxes, returning those panes. */
export function reconcileSleepingMail(
  wake: SleptMailboxWake,
  panes: Iterable<string>,
  inboxes: (pane: string) => string[],
  named: Iterable<string> = []
): Set<string> {
  const affected = new Set(panes)
  const mailboxes = new Set([...wake.trackedMailboxes(), ...named])
  for (const pane of affected) {
    for (const mailbox of paneMailboxes(wake, pane, inboxes)) {
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
  mailboxes: Iterable<string>,
  panes: Iterable<string>,
  inboxes: (pane: string) => string[]
): Set<string> {
  const affected = new Set(panes)
  const named = new Set(mailboxes)
  for (const pane of affected) {
    for (const mailbox of [...wake.mailboxesForPane(pane), ...paneMailboxes(wake, pane, inboxes)]) {
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
