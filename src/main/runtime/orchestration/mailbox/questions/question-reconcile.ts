// SPIKE, not for merge: the PR 3 reconcile in shadow mode. It decides "would tell the asker now" for
// each question its taker holds, records the decision, and sends nothing. Fail loud by construction:
// anything it can't prove holds a wake (running, mail a pass would hand over, a linked worker) notifies.
import type { OrchestrationDb } from '../../db/orchestration-db'
import { selectOrchestrationPointerBatch } from '../terminal-pointer/mailbox-pointer-eligibility'
import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'

export type ReconcileHost = {
  /** The party's lead turn is running and no person is being asked. Unreadable → false. */
  running(party: string): boolean
  /** A delivery pass can wake this party now (live fence, a bot Home mail reopens, a live pane). */
  canAttach(party: string): boolean
  /** The mailboxes the party reads now. */
  mailboxes(party: string): readonly string[]
  /** The taker key of a dispatch's worker, or null while it has none yet. */
  dispatchParty(dispatchId: string): string | null
}

export type ShadowDecision = {
  messageId: string
  taker: string
  kind: 'bot' | 'worker-ask'
  reason: string
}

const TABLE = { bot: 'bot_requests', 'worker-ask': 'question_threads' } as const
const NEVER_RUNS = /^(shell|reply|orca|dropped:.*)$/

export function ensureShadowTable(db: OrchestrationDb): void {
  db.db.exec(`CREATE TABLE IF NOT EXISTS question_shadow_decisions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    taker TEXT NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`)
}

function wakePending(db: OrchestrationDb, host: ReconcileHost, party: string): boolean {
  if (NEVER_RUNS.test(party) || !host.canAttach(party)) {
    return false
  }
  return host.mailboxes(party).some(
    (mailboxHandle) =>
      inFlight(db, mailboxHandle) ||
      selectOrchestrationPointerBatch({
        db,
        mailboxHandle,
        waiters: undefined,
        reservedTypes: new Set(['heartbeat'])
      }).messages.length > 0
  )
}

/** Found live (G2): mail already handed over (a card being sent, a pointer whose Enter is pending)
 *  but not yet started as a turn is a wake in flight, though selection no longer offers it. */
function inFlight(db: OrchestrationDb, mailboxHandle: string): boolean {
  return (
    db.db
      .prepare(
        `SELECT 1 FROM structured_mail_sends s JOIN messages m ON m.id = s.message_id
         WHERE s.mailbox_handle = ? AND m.read = 0
         UNION ALL
         SELECT 1 FROM messages WHERE to_handle = ? AND read = 0 AND pointer_enter_pending != 0
         LIMIT 1`
      )
      .get(mailboxHandle, mailboxHandle) !== undefined
  )
}

function busy(db: OrchestrationDb, host: ReconcileHost, party: string): string | null {
  if (NEVER_RUNS.test(party)) {
    return null
  }
  if (host.running(party)) {
    return 'running'
  }
  return wakePending(db, host, party) ? 'mail would wake it' : null
}

/** The open dispatches started `--for` this question, and every open helper below them. */
function linkedDispatches(db: OrchestrationDb, messageId: string): string[] {
  const rows = db.db
    .prepare(
      `WITH RECURSIVE linked(id) AS (
         SELECT id FROM dispatch_contexts WHERE for_message_id = ?
         UNION SELECT d.id FROM dispatch_contexts d JOIN linked l ON d.creator_dispatch_id = l.id
       )
       SELECT d.id FROM dispatch_contexts d JOIN linked l ON d.id = l.id
       WHERE d.status IN ('pending', 'dispatched')`
    )
    .all(messageId) as { id: string }[]
  return rows.map((row) => row.id)
}

function linkedWorking(db: OrchestrationDb, host: ReconcileHost, messageId: string): string | null {
  for (const dispatchId of linkedDispatches(db, messageId)) {
    const worker = db.getWorkerDispatch(dispatchId)
    const party = host.dispatchParty(dispatchId)
    if (worker?.state === 'starting' || !party) {
      return `linked ${dispatchId} is starting`
    }
    const why = busy(db, host, party)
    if (why) {
      return `linked ${dispatchId}: ${why}`
    }
  }
  return null
}

/** Decides every question `taker` holds. Returns the would-notify decisions it recorded. */
export function reconcileQuestions(
  db: OrchestrationDb,
  host: ReconcileHost,
  taker: string
): ShadowDecision[] {
  ensureShadowTable(db)
  const candidates = db.db
    .prepare(
      `SELECT message_id, 'worker-ask' AS kind FROM question_threads WHERE awaiting = 1 AND taken_by = ?
       UNION ALL
       SELECT message_id, 'bot' AS kind FROM bot_requests WHERE awaiting = 1 AND taken_by = ?`
    )
    .all(taker, taker) as { message_id: string; kind: ShadowDecision['kind'] }[]
  if (candidates.length === 0 || busy(db, host, taker)) {
    return []
  }
  const decisions: ShadowDecision[] = []
  for (const candidate of candidates) {
    const decision = runLifecycleWriteTransaction(db.db, 'shadow_question_notice', () => {
      // Re-decided inside the write, so a commit that raced the read above can't be missed.
      if (
        busy(db, host, taker) ||
        (process.env.AQ_MUTATE !== 'no-linked' && linkedWorking(db, host, candidate.message_id))
      ) {
        return null
      }
      const cleared = db.db
        .prepare(
          `UPDATE ${TABLE[candidate.kind]} SET awaiting = NULL WHERE message_id = ? AND awaiting = 1`
        )
        .run(candidate.message_id).changes
      if (cleared !== 1) {
        return null
      }
      const linked = linkedDispatches(db, candidate.message_id).length
      const reason = taker.startsWith('dropped:')
        ? `dropped unread (${taker.slice('dropped:'.length)})`
        : `${taker} stopped, no mail would wake it${linked ? `, ${linked} linked worker(s) stopped` : ''}`
      db.db
        .prepare(
          'INSERT INTO question_shadow_decisions (message_id, taker, kind, reason) VALUES (?, ?, ?, ?)'
        )
        .run(candidate.message_id, taker, candidate.kind, reason)
      return { messageId: candidate.message_id, taker, kind: candidate.kind, reason }
    })
    if (decision) {
      console.info(`[question-shadow] would notify ${decision.messageId} now: ${decision.reason}`)
      decisions.push(decision)
    }
  }
  return decisions
}

/** E9: every taker still holding an awaiting question. */
export function awaitingTakers(db: OrchestrationDb): string[] {
  const rows = db.db
    .prepare(
      `SELECT taken_by FROM question_threads WHERE awaiting = 1
       UNION SELECT taken_by FROM bot_requests WHERE awaiting = 1`
    )
    .all() as { taken_by: string }[]
  return rows.map((row) => row.taken_by)
}

/** E5/E1 for linked workers: the takers whose questions this dispatch was started for. */
export function takersLinkedTo(db: OrchestrationDb, dispatchId: string): string[] {
  const rows = db.db
    .prepare(
      `WITH RECURSIVE up(id, creator, for_id) AS (
         SELECT id, creator_dispatch_id, for_message_id FROM dispatch_contexts WHERE id = ?
         UNION SELECT d.id, d.creator_dispatch_id, d.for_message_id
         FROM dispatch_contexts d JOIN up ON d.id = up.creator
       )
       SELECT q.taken_by FROM up JOIN question_threads q ON q.message_id = up.for_id
       WHERE q.awaiting = 1
       UNION SELECT b.taken_by FROM up JOIN bot_requests b ON b.message_id = up.for_id
       WHERE b.awaiting = 1`
    )
    .all(dispatchId) as { taken_by: string }[]
  return rows.map((row) => row.taken_by)
}
