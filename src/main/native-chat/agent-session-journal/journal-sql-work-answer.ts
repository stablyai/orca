import type { SqlAgentSessionJournal } from './journal-sql-store'
import {
  copyJournalCurrentWorkAuthority,
  type JournalCurrentWorkAuthority
} from './journal-observer-read'
import type { JournalWorkRead, JournalWorkAnswer, JournalSqlWorkResult } from './journal-work-read'
import { sameJournalCursor } from './replay/journal-cursor'
import { AgentSessionJournalError } from './writing/journal-write-guards'

type WorkAnswerJournal = Pick<
  SqlAgentSessionJournal,
  | 'isClosed'
  | 'identity'
  | 'reads'
  | 'cursor'
  | 'physicalCursor'
  | 'observationHandle'
  | 'openingCursor'
>

/** Compare the worker snapshot with the same finite authority at its held lane position. */
export function journalSqlWorkAnswerIsCurrent(
  journal: WorkAnswerJournal,
  capture: () => JournalCurrentWorkAuthority,
  authority: JournalCurrentWorkAuthority,
  answer: JournalSqlWorkResult
): boolean {
  const signature = JSON.stringify(authority)
  return (
    !journal.isClosed &&
    sameJournalCursor(answer.cursor, journal.cursor()) &&
    sameJournalCursor(answer.physicalCursor, journal.physicalCursor()) &&
    authority.handle === journal.observationHandle() &&
    sameJournalCursor(authority.openedThrough, journal.openingCursor()) &&
    JSON.stringify(copyJournalCurrentWorkAuthority(capture())) === signature &&
    JSON.stringify(answer.authority) === signature
  )
}

/** Validate the worker snapshot and live owners before returning action evidence. */
export async function readJournalSqlWorkAnswer<K extends JournalWorkRead['kind']>(
  journal: WorkAnswerJournal,
  capture: () => JournalCurrentWorkAuthority,
  operation: Extract<JournalWorkRead, { kind: K }>
): Promise<JournalWorkAnswer<K>> {
  const requested: JournalWorkRead = structuredClone(operation)
  for (;;) {
    if (journal.isClosed) {
      throw new AgentSessionJournalError(
        'journal_closed',
        `the journal for ${journal.identity.sessionId} is closed`
      )
    }
    const authority = copyJournalCurrentWorkAuthority(capture())
    let answer: JournalSqlWorkResult
    if (requested.kind === 'input' && requested.resolved) {
      const queue = await journal.reads.queue({
        kind: 'eligible-input-card',
        authority,
        allowSteer: requested.allowSteer,
        now: requested.now,
        facts: requested.facts,
        resolved: requested.resolved
      })
      if (queue.kind !== 'eligible-input-card' || !queue.work) {
        throw new Error('journal queue reader omitted its resolved work answer')
      }
      answer = queue.work
    } else {
      answer = await journal.reads.work({ authority, operation: requested })
    }
    if (journalSqlWorkAnswerIsCurrent(journal, capture, authority, answer)) {
      if (answer.result.kind !== operation.kind) {
        throw new Error(`journal work reader answered ${answer.result.kind} for ${operation.kind}`)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the named result's discriminant was checked above.
      return answer.result as JournalWorkAnswer<K>
    }
  }
}
