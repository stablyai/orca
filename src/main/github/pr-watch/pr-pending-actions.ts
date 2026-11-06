// A finished call's PR obligations, saved in the transaction that commits the call, so a crash
// between the call and its verification loses nothing and nothing older is ever replayed.

import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalRow } from '../../native-chat/agent-session-journal/journal-row-schema'
import type Database from '../../sqlite/sync-database'
import type { GitPushUpdate } from './git-push-update-lines'
import {
  finishedShellCall,
  pullRequestsOpenedByCall,
  pushUpdatesByCall,
  type PRChatOpened
} from './pr-chat-action-recorder'
import { hasPRChatActionFrom } from './pr-watch-tables'

/** Workspace and repository resolution may still succeed until then. */
export const PR_ACTION_RESOLVE_WINDOW_MS = 24 * 60 * 60_000
/** A push's PR-head check: git's two minutes, plus three for GitHub to show the push. */
export const PR_ACTION_VERIFY_WINDOW_MS = 5 * 60_000

export type PRPendingObligation =
  | { kind: 'opened'; target: PRChatOpened }
  | { kind: 'pushed'; target: { branch: string }; evidence: Omit<GitPushUpdate, 'branch'> }

export type PRPendingActionRow = {
  chatId: string
  anchor: { itemId: string; revision: number }
  obligations: PRPendingObligation[]
  finishedAt: number
  resolveDeadlineAt: number
  verifyDeadlineAt: number
  attempts: number
}

/** The call's obligations: each PR it created and each ref its own output says it updated. */
function obligationsOf(chatId: string, row: JournalRow, finishedAt: number): PRPendingObligation[] {
  const call = row.kind === 'item' ? finishedShellCall(chatId, row, finishedAt) : null
  if (!call) {
    return []
  }
  return [
    ...pullRequestsOpenedByCall(call).map((target) => ({ kind: 'opened' as const, target })),
    ...pushUpdatesByCall(call).map(({ branch, ...evidence }) => ({
      kind: 'pushed' as const,
      target: { branch },
      evidence
    }))
  ]
}

/**
 * Runs in the journal writer's transaction for every write. Only a live finish counts: a batch that
 * starts or replaces an epoch (imports, forks, context rewinds), a recovered row, or a revision of a
 * call that had already finished (a rewind restating it) is history, not a call this build just saw. Never throws: a detector
 * bug must not roll back the agent's own row.
 */
export function capturePRPendingActions(
  db: Database.Database,
  sessionId: string,
  rows: readonly JournalRow[],
  committedAt: number,
  previous: (itemId: string) => AgentJournalItemBody | undefined
): void {
  try {
    if (rows.some((row) => row.kind === 'epoch')) {
      return
    }
    const insert = db.prepare(
      `INSERT OR IGNORE INTO pr_pending_actions (chat_id, anchor_item_id, anchor_revision,
        evidence_json, finished_at, resolve_deadline_at, verify_deadline_at, next_attempt_at,
        attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    for (const row of rows) {
      const before = row.kind === 'item' ? previous(row.itemId) : undefined
      const alreadyFinished =
        before?.kind === 'tool-call' && (before.state === 'completed' || before.state === 'failed')
      if (row.kind !== 'item' || row.recovered || alreadyFinished) {
        continue
      }
      const obligations = obligationsOf(sessionId, row, committedAt)
      if (obligations.length === 0 || hasPRChatActionFrom(db, sessionId, row.itemId)) {
        continue
      }
      insert.run(
        sessionId,
        row.itemId,
        row.revision,
        JSON.stringify(obligations),
        committedAt,
        committedAt + PR_ACTION_RESOLVE_WINDOW_MS,
        committedAt + PR_ACTION_VERIFY_WINDOW_MS,
        committedAt
      )
    }
  } catch (error) {
    console.warn('[pr-watch] capturing a pull request action failed', error)
  }
}

type StoredRow = {
  chat_id: string
  anchor_item_id: string
  anchor_revision: number
  evidence_json: string
  finished_at: number
  resolve_deadline_at: number
  verify_deadline_at: number
  attempts: number
}

/** Rows due now, oldest attempt first; at most `limit` per pass. */
export function readDuePRPendingActions(
  db: Database.Database,
  now: number,
  limit: number
): PRPendingActionRow[] {
  const rows = db
    .prepare(
      'SELECT * FROM pr_pending_actions WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?'
    )
    .all(now, limit) as StoredRow[]
  return rows.map((row) => ({
    chatId: row.chat_id,
    anchor: { itemId: row.anchor_item_id, revision: row.anchor_revision },
    obligations: JSON.parse(row.evidence_json) as PRPendingObligation[],
    finishedAt: row.finished_at,
    resolveDeadlineAt: row.resolve_deadline_at,
    verifyDeadlineAt: row.verify_deadline_at,
    attempts: row.attempts
  }))
}

export function nextPRPendingActionAt(db: Database.Database): number | null {
  const row = db.prepare('SELECT MIN(next_attempt_at) AS next FROM pr_pending_actions').get() as {
    next: number | null
  }
  return row.next
}

/** A transient failure: back off, with the deadlines fixed at capture. */
export function deferPRPendingAction(
  db: Database.Database,
  row: PRPendingActionRow,
  nextAttemptAt: number
): void {
  db.prepare(
    `UPDATE pr_pending_actions SET next_attempt_at = ?, attempts = attempts + 1
      WHERE chat_id = ? AND anchor_item_id = ?`
  ).run(nextAttemptAt, row.chatId, row.anchor.itemId)
}

export function deletePRPendingAction(db: Database.Database, row: PRPendingActionRow): void {
  db.prepare('DELETE FROM pr_pending_actions WHERE chat_id = ? AND anchor_item_id = ?').run(
    row.chatId,
    row.anchor.itemId
  )
}
