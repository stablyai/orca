import type { JournalWriterCommit } from '../../native-chat/agent-session-journal/journal-writer-changes'
// A finished call's PR obligations, saved in the transaction that commits the call, so a crash
// between the call and its verification loses nothing and nothing older is ever replayed.

import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalRow } from '../../native-chat/agent-session-journal/durable-rows/journal-row-schema'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type Database from '../../sqlite/sync-database'
import type { GitPushUpdate } from './git-push-update-lines'
import {
  finishedShellCall,
  pullRequestsOpenedByCall,
  pushUpdatesByCall,
  type PRChatOpened
} from './pr-chat-action-recorder'
import { numberColumn, textColumn } from './pr-watch-sqlite-columns'
import { hasPRChatActionFrom } from './pr-watch-tables'

/** Workspace and repository resolution may still succeed until then. */
export const PR_ACTION_RESOLVE_WINDOW_MS = 24 * 60 * 60_000
/** A push's PR-head check: git's two minutes, plus three for GitHub to show the push. */
export const PR_ACTION_VERIFY_WINDOW_MS = 5 * 60_000

/** `done`: verified (its action already saved) or terminal; the row ends when all are. */
export type PRPendingObligation = (
  | { kind: 'opened'; target: PRChatOpened }
  | { kind: 'pushed'; target: { branch: string }; evidence: Omit<GitPushUpdate, 'branch'> }
) & { done?: true }

export type PRPendingActionRow = {
  chatId: string
  anchor: { itemId: string; revision: number }
  obligations: PRPendingObligation[]
  finishedAt: number
  resolveDeadlineAt: number
  verifyDeadlineAt: number
  attempts: number
}

type ItemWrite = { itemId: string; revision: number; body: AgentJournalItemBody }

/** Item writes a live batch makes: plain item rows, and the item mutations a lifecycle batch
 *  commits (a turn's end settling a tool call). Recovered writes are history. */
function liveItemWrites(rows: readonly JournalRow[]): ItemWrite[] {
  return rows.flatMap((row): ItemWrite[] => {
    if (row.recovered) {
      return []
    }
    if (row.kind === 'item') {
      return [row]
    }
    return row.kind === 'lifecycle-batch'
      ? row.mutations.flatMap((mutation) => (mutation.kind === 'item' ? [mutation] : []))
      : []
  })
}

/** A committed batch that finished a call, so it may have captured work to resume. */
export function finishesPRActionCall(commit: JournalWriterCommit | undefined): boolean {
  return (
    commit?.publication?.items.some(
      ({ body }) =>
        body.kind === 'tool-call' && (body.state === 'completed' || body.state === 'failed')
    ) === true
  )
}

/** The call's obligations: each PR it created and each ref its own output says it updated. */
function obligationsOf(chatId: string, item: ItemWrite, finishedAt: number): PRPendingObligation[] {
  const call = finishedShellCall(chatId, item, finishedAt)
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
    for (const row of liveItemWrites(rows)) {
      capturePRPendingAction(db, sessionId, row, committedAt, previous(row.itemId))
    }
  } catch (error) {
    console.warn('[pr-watch] capturing a pull request action failed', error)
  }
}

/** Row-local capture runs in the live item's savepoint, never during history installation. */
export function capturePRPendingAction(
  db: Database.Database,
  sessionId: string,
  item: ItemWrite,
  committedAt: number,
  previous: AgentJournalItemBody | undefined
): void {
  if (
    item.body.kind !== 'tool-call' ||
    (item.body.state !== 'completed' && item.body.state !== 'failed') ||
    (previous?.kind === 'tool-call' &&
      (previous.state === 'completed' || previous.state === 'failed'))
  ) {
    return
  }
  try {
    const obligations = obligationsOf(sessionId, item, committedAt)
    if (obligations.length === 0 || hasPRChatActionFrom(db, sessionId, item.itemId)) {
      return
    }
    db.prepare(`INSERT OR IGNORE INTO pr_pending_actions (chat_id, anchor_item_id,
      anchor_revision, evidence_json, finished_at, resolve_deadline_at, verify_deadline_at,
      next_attempt_at, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
      sessionId,
      item.itemId,
      item.revision,
      JSON.stringify(obligations),
      committedAt,
      committedAt + PR_ACTION_RESOLVE_WINDOW_MS,
      committedAt + PR_ACTION_VERIFY_WINDOW_MS,
      committedAt
    )
  } catch (error) {
    console.warn('[pr-watch] capturing a pull request action failed', error)
  }
}

function rowFromStored(row: SqliteRow): PRPendingActionRow[] {
  const chatId = textColumn(row, 'chat_id')
  const itemId = textColumn(row, 'anchor_item_id')
  const evidence = textColumn(row, 'evidence_json')
  const revision = numberColumn(row, 'anchor_revision')
  const finishedAt = numberColumn(row, 'finished_at')
  const resolveDeadlineAt = numberColumn(row, 'resolve_deadline_at')
  const verifyDeadlineAt = numberColumn(row, 'verify_deadline_at')
  const attempts = numberColumn(row, 'attempts')
  if (
    chatId === null ||
    itemId === null ||
    evidence === null ||
    revision === null ||
    finishedAt === null ||
    resolveDeadlineAt === null ||
    verifyDeadlineAt === null ||
    attempts === null
  ) {
    return []
  }
  const obligations: PRPendingObligation[] = JSON.parse(evidence)
  return [
    {
      chatId,
      anchor: { itemId, revision },
      obligations,
      finishedAt,
      resolveDeadlineAt,
      verifyDeadlineAt,
      attempts
    }
  ]
}

/** Rows due now and not already running (`chat\0anchor` keys), oldest attempt first. */
export function readDuePRPendingActions(
  db: Database.Database,
  now: number,
  limit: number,
  running: readonly string[]
): PRPendingActionRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM pr_pending_actions WHERE next_attempt_at <= ?
        AND chat_id || char(0) || anchor_item_id NOT IN (SELECT value FROM json_each(?))
        ORDER BY next_attempt_at LIMIT ?`
    )
    .all(now, JSON.stringify(running), limit)
  return rows.flatMap(rowFromStored)
}

/** The earliest attempt still to come; rows already due are running or about to run. */
export function nextPRPendingActionAt(db: Database.Database, after: number): number | null {
  const row = db
    .prepare(
      'SELECT MIN(next_attempt_at) AS next FROM pr_pending_actions WHERE next_attempt_at > ?'
    )
    .get(after)
  return row ? numberColumn(row, 'next') : null
}

/** Marks obligations done in the saved row; the row is deleted once every one is. */
export function markPRPendingObligationsDone(
  db: Database.Database,
  row: PRPendingActionRow,
  indices: readonly number[]
): void {
  const stored = db
    .prepare(
      'SELECT evidence_json FROM pr_pending_actions WHERE chat_id = ? AND anchor_item_id = ?'
    )
    .get(row.chatId, row.anchor.itemId)
  const evidence = stored ? textColumn(stored, 'evidence_json') : null
  if (evidence === null) {
    return
  }
  const obligations: PRPendingObligation[] = JSON.parse(evidence)
  for (const index of indices) {
    obligations[index].done = true
  }
  if (obligations.every((obligation) => obligation.done)) {
    deletePRPendingAction(db, row)
    return
  }
  db.prepare(
    'UPDATE pr_pending_actions SET evidence_json = ? WHERE chat_id = ? AND anchor_item_id = ?'
  ).run(JSON.stringify(obligations), row.chatId, row.anchor.itemId)
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

export function openPRPendingObligations(row: PRPendingActionRow): number[] {
  return row.obligations.flatMap((obligation, index) => (obligation.done ? [] : [index]))
}

/** The key due reads exclude a running row by. */
export function prPendingActionKey(row: PRPendingActionRow): string {
  return `${row.chatId}\0${row.anchor.itemId}`
}
