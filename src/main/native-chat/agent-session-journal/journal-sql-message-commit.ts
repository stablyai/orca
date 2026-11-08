import type Database from '../../sqlite/sync-database'
import type {
  JournalSqlBatch,
  JournalSqlBatchOutcome,
  JournalSqlBatchResult
} from './journal-sql-batch'
import {
  applyJournalSqlMessage,
  JournalMessageNeedsFull,
  type JournalSqlMessage,
  type JournalSqlMessageCommit
} from './journal-sql-message'

type MessageCommand = {
  target: { sessionId: string; epoch: string }
  steps: readonly JournalSqlMessage[]
  savedAt: number
}

export type JournalSqlMessageJob = {
  command: MessageCommand
  bytes: number
  normal: boolean
}

export type JournalSqlMessagesCommit = Omit<JournalSqlMessageCommit, 'outcome'> & {
  outcomes: JournalSqlMessageCommit['outcome'][]
  failure?: { message: string }
}

/** Sender work; the writer drains the already classified and sized command. */
export function prepareJournalSqlMessages(command: MessageCommand): JournalSqlMessageJob {
  return {
    command,
    bytes: Buffer.byteLength(JSON.stringify(command), 'utf8'),
    normal: command.steps.length > 0 && command.steps.every((step) => step.kind === 'text-snapshot')
  }
}

/** Select one ready prefix; controls and repeated chats keep their serialization boundary. */
export function journalSqlMessageBatchSize<T>(
  ready: readonly T[],
  jobFor: (entry: T) => JournalSqlMessageJob | undefined,
  at = 0
): number {
  const sessions = new Set<string>()
  let bytes = 0
  let events = 0
  let count = 0
  for (let next = at; next < ready.length; next++) {
    const job = jobFor(ready[next]!)
    if (!job) {
      break
    }
    const size = Math.max(1, job.command.steps.length)
    if (
      count &&
      (!job.normal ||
        sessions.has(job.command.target.sessionId) ||
        bytes + job.bytes > 1024 * 1024 ||
        events + size > 64)
    ) {
      break
    }
    count++
    bytes += job.bytes
    events += size
    sessions.add(job.command.target.sessionId)
    if (!job.normal || bytes >= 1024 * 1024 || events >= 64) {
      break
    }
  }
  return count
}

/** Called by the existing writer admission lane; publication completes before the next drain. */
export async function commitJournalSqlMessages(
  db: Database.Database,
  batch: JournalSqlBatch,
  jobs: readonly JournalSqlMessageJob[],
  publish: (commit: JournalSqlMessagesCommit, index: number) => void
): Promise<JournalSqlBatchResult<JournalSqlMessagesCommit>> {
  const outcomes: JournalSqlBatchOutcome<JournalSqlMessagesCommit>[] = []
  let at = 0
  while (at < jobs.length) {
    const ready = jobs.slice(at, at + journalSqlMessageBatchSize(jobs, (job) => job, at))
    const result = await batch.run(
      ready.map((job) => ({ command: job, normal: job.normal })),
      (job) => applyMessageSteps(db, job)
    )
    for (const [index, outcome] of result.outcomes.entries()) {
      if (outcome.committed) {
        // Payloads are owned by this just-committed result, never reloaded through a reader.
        publish(outcome.value, at + index)
      }
    }
    for (let index = 0; index < result.outcomes.length; index++) {
      let outcome = result.outcomes[index]!
      if (
        !outcome.committed &&
        outcome.error instanceof JournalMessageNeedsFull &&
        !result.postcommit
      ) {
        const job = { ...ready[index]!, normal: false }
        const rerouted = await batch.run([{ command: job, normal: false }], (job) =>
          applyMessageSteps(db, job)
        )
        outcome = rerouted.outcomes[0]!
        if (outcome.committed) {
          publish(outcome.value, at + index)
        }
        if (rerouted.postcommit) {
          outcomes.push(outcome)
          return { outcomes, postcommit: rerouted.postcommit }
        }
      }
      outcomes.push(outcome)
    }
    if (result.postcommit) {
      return { outcomes, postcommit: result.postcommit }
    }
    at += ready.length
  }
  return { outcomes }
}

function applyMessageSteps(
  db: Database.Database,
  job: JournalSqlMessageJob
): JournalSqlMessagesCommit {
  const { target, steps, savedAt } = job.command
  const head = db
    .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal message targets a retired chat epoch')
  }
  const result: JournalSqlMessagesCommit = {
    cursor: { epoch: target.epoch, sequence: Number(head.last_sequence) },
    outcomes: [],
    items: [],
    receipts: [],
    cards: [],
    inputChanged: false
  }
  for (const step of steps) {
    db.exec('SAVEPOINT journal_message_step')
    try {
      const commit = applyJournalSqlMessage(db, target, step, savedAt, job.normal)
      db.exec('RELEASE journal_message_step')
      result.cursor = commit.cursor
      result.outcomes.push(commit.outcome)
      result.items.push(...commit.items)
      result.receipts.push(...commit.receipts)
      result.cards.push(...commit.cards)
      result.inputChanged ||= commit.inputChanged
      result.acceptedInputs = commit.acceptedInputs ?? result.acceptedInputs
    } catch (error) {
      db.exec('ROLLBACK TO journal_message_step; RELEASE journal_message_step')
      if (error instanceof JournalMessageNeedsFull) {
        throw error
      }
      result.failure = { message: error instanceof Error ? error.message : String(error) }
      break
    }
  }
  return result
}
