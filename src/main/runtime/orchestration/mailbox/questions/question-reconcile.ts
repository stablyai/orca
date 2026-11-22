// Whether an agent question's asker is owed a notice now: its taker stopped without answering, no
// delivery would wake that taker, and no worker started `--for` the question still runs. Each fact
// that can't be read counts toward telling, so a question is never held silently; at worst the
// asker hears once and the answer still lands later.
import type { OrchestrationDb } from '../../db/orchestration-db'
import { selectOrchestrationPointerBatch } from '../terminal-pointer/mailbox-pointer-eligibility'
import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'

/** What a decision reads about a party (a taker key, or a linked worker's), read fresh by the caller. */
export type QuestionPartyFacts = {
  /** Its lead turn runs, or owes a queued send, with no person asked. Unreadable → false. */
  running(party: string): boolean
  /** The mailboxes a delivery pass would hand this party mail from now; none when it can't attach. */
  mailboxes(party: string): readonly string[]
  /** A delivery pass is handing this mailbox's mail to the party right now (in memory, ended in a
   *  `finally`), so no durable row can hold a question after its handover settled or failed. */
  handingOver(party: string, mailbox: string): boolean
  /** The taker key of a Dispatch's worker; null while it has none yet. */
  dispatchParty(dispatchId: string): string | null
}

export type QuestionKind = 'worker-ask' | 'remote-ask' | 'bot'
export type QuestionNotice = { messageId: string; taker: string; kind: QuestionKind }

/** The question tables, worker asks first: telling one can wake a worker started for another. */
const QUESTION_TABLE: Record<QuestionKind, string> = {
  'worker-ask': 'question_threads',
  'remote-ask': 'remote_owned_questions',
  bot: 'bot_requests'
}
const QUESTION_KINDS: readonly QuestionKind[] = ['worker-ask', 'remote-ask', 'bot']

/** Writes the notice and the question's outcome, inside the decision's transaction. 'unverified'
 *  leaves the question awaiting: its asker can't be resolved yet, so a later edge tries again.
 *  'sending': the notice goes to a paired computer, which records the outcome once it lands. */
export type QuestionNoticeWriter = (notice: QuestionNotice) => 'told' | 'unverified' | 'sending'

// Takers that never run again: a caller with no agent behind it, or a drop.
const NEVER_RUNS = /^(shell|reply|orca|dropped:.*)$/

function wakePending(db: OrchestrationDb, facts: QuestionPartyFacts, party: string): boolean {
  const mailboxes = facts.mailboxes(party)
  // As terminal delivery: with no Run bound, a Run's rows in its own mailbox wait to be routed
  // elsewhere; a bound Run's rows are routed into its mailbox and typed.
  const ownMailboxSkipsRunRows = !mailboxes.some((mailbox) => mailbox.startsWith('run:'))
  return mailboxes.some(
    (mailboxHandle) =>
      facts.handingOver(party, mailboxHandle) ||
      selectOrchestrationPointerBatch({
        db,
        mailboxHandle,
        waiters: undefined,
        reservedTypes: new Set(['heartbeat']),
        excludeRunOwnedDirect: ownMailboxSkipsRunRows && party === `terminal:${mailboxHandle}`
      }).messages.length > 0
  )
}

function busy(db: OrchestrationDb, facts: QuestionPartyFacts, party: string): boolean {
  return !NEVER_RUNS.test(party) && (facts.running(party) || wakePending(db, facts, party))
}

/** The open Dispatches started `--for` this question, and every open helper below them. */
export function linkedDispatches(db: OrchestrationDb, messageId: string): string[] {
  return db.db
    .prepare(
      `WITH RECURSIVE linked(id) AS (
         SELECT id FROM dispatch_contexts WHERE for_message_id = ?
         UNION SELECT d.id FROM dispatch_contexts d JOIN linked l ON d.creator_dispatch_id = l.id
       )
       SELECT d.id FROM dispatch_contexts d JOIN linked l ON d.id = l.id
       WHERE d.status IN ('pending', 'dispatched')`
    )
    .all(messageId)
    .flatMap(({ id }) => (typeof id === 'string' ? [id] : []))
}

function linkedWorking(db: OrchestrationDb, facts: QuestionPartyFacts, messageId: string): boolean {
  return linkedDispatches(db, messageId).some((dispatchId) => {
    const party = facts.dispatchParty(dispatchId)
    // A worker still starting has no turn to observe yet; its start settles through E5.
    return (
      !party || db.getWorkerDispatch(dispatchId)?.state === 'starting' || busy(db, facts, party)
    )
  })
}

/** Questions this taker holds whose asker may still be owed a notice, worker asks first. */
export function awaitingQuestions(
  db: OrchestrationDb,
  taker: string
): { messageId: string; kind: QuestionKind }[] {
  return QUESTION_KINDS.flatMap((kind) =>
    db.db
      .prepare(`SELECT message_id FROM ${QUESTION_TABLE[kind]} WHERE awaiting = 1 AND taken_by = ?`)
      .all(taker)
      .flatMap(({ message_id }) =>
        typeof message_id === 'string' ? [{ messageId: message_id, kind }] : []
      )
  )
}

/** Every taker still holding a question whose asker may be owed a notice. */
export function awaitingTakers(db: OrchestrationDb): string[] {
  return db.db
    .prepare(
      `SELECT taken_by FROM question_threads WHERE awaiting = 1
       UNION SELECT taken_by FROM remote_owned_questions WHERE awaiting = 1
       UNION SELECT taken_by FROM bot_requests WHERE awaiting = 1`
    )
    .all()
    .flatMap(({ taken_by }) => (typeof taken_by === 'string' ? [taken_by] : []))
}

/** The takers holding a question a worker on this paired computer asked, still awaiting. */
export function remoteAskTakers(db: OrchestrationDb, environmentId: string): string[] {
  return db.db
    .prepare(
      `SELECT DISTINCT taken_by FROM remote_owned_questions
       WHERE awaiting = 1 AND environment_id = ?`
    )
    .all(environmentId)
    .flatMap(({ taken_by }) => (typeof taken_by === 'string' ? [taken_by] : []))
}

/** The takers whose questions this Dispatch, or a Dispatch above it, was started for. */
export function takersLinkedTo(db: OrchestrationDb, dispatchId: string): string[] {
  return db.db
    .prepare(
      `WITH RECURSIVE up(id, creator, for_id) AS (
         SELECT id, creator_dispatch_id, for_message_id FROM dispatch_contexts WHERE id = ?
         UNION SELECT d.id, d.creator_dispatch_id, d.for_message_id
         FROM dispatch_contexts d JOIN up ON d.id = up.creator
       )
       SELECT b.taken_by FROM up JOIN bot_requests b ON b.message_id = up.for_id
       WHERE b.awaiting = 1
       UNION SELECT q.taken_by FROM up JOIN question_threads q ON q.message_id = up.for_id
       WHERE q.awaiting = 1
       UNION SELECT r.taken_by FROM up JOIN remote_owned_questions r ON r.message_id = up.for_id
       WHERE r.awaiting = 1`
    )
    .all(dispatchId)
    .flatMap(({ taken_by }) => (typeof taken_by === 'string' ? [taken_by] : []))
}

/** Decides each question `taker` holds, and tells the askers owed a notice now. */
export function reconcileQuestions(
  db: OrchestrationDb,
  facts: QuestionPartyFacts,
  write: QuestionNoticeWriter,
  taker: string
): QuestionNotice[] {
  const candidates = awaitingQuestions(db, taker)
  if (candidates.length === 0 || busy(db, facts, taker)) {
    return []
  }
  const told: QuestionNotice[] = []
  for (const { messageId, kind } of candidates) {
    const table = QUESTION_TABLE[kind]
    const notice = runLifecycleWriteTransaction(db.db, 'agent_question_notice', () => {
      // Decided again inside the write, so a commit that raced the reads above is seen; a worker
      // ask told just before can have woken the worker started for this one.
      if (busy(db, facts, taker) || linkedWorking(db, facts, messageId)) {
        return null
      }
      const still = db.db
        .prepare(`SELECT 1 FROM ${table} WHERE message_id = ? AND awaiting = 1`)
        .get(messageId)
      if (!still) {
        return null
      }
      const decided: QuestionNotice = { messageId, taker, kind }
      if (write(decided) !== 'told') {
        return null
      }
      // Every outcome writer clears it; a question with no record to tell ends here too.
      db.db.prepare(`UPDATE ${table} SET awaiting = NULL WHERE message_id = ?`).run(messageId)
      return decided
    })
    if (notice) {
      told.push(notice)
    }
  }
  return told
}
