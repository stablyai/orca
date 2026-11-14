import type { SqlAgentSessionJournal } from './journal-sql-store'
import {
  copyJournalCurrentWorkAuthority,
  type JournalCurrentWorkAuthority
} from './journal-observer-read'
import type { JournalWorkRead, JournalWorkAnswer, JournalSqlWorkResult } from './journal-work-read'
import { sameJournalCursor } from './replay/journal-cursor'
import { AgentSessionJournalError } from './writing/journal-write-guards'
import type { JournalDomainHistoryWork } from './journal-domain-history-page'

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
  for (;;) {
    const answer = await readJournalSqlWorkAnswerOnce(journal, capture, operation)
    if (answer) {
      return answer
    }
  }
}

/** One request at `authority` (by default the live one); null when the answer no longer matches
 *  live owners or the adopted cursor. Publication reads use this: the change that moved authority
 *  schedules its own redelivery. */
export async function readJournalSqlWorkAnswerOnce<K extends JournalWorkRead['kind']>(
  journal: WorkAnswerJournal,
  capture: () => JournalCurrentWorkAuthority,
  operation: Extract<JournalWorkRead, { kind: K }>,
  at?: JournalCurrentWorkAuthority
): Promise<JournalWorkAnswer<K> | null> {
  if (journal.isClosed) {
    throw new AgentSessionJournalError(
      'journal_closed',
      `the journal for ${journal.identity.sessionId} is closed`
    )
  }
  const requested: JournalWorkRead = structuredClone(operation)
  const authority = copyJournalCurrentWorkAuthority(at ?? capture())
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
  if (!journalSqlWorkAnswerIsCurrent(journal, capture, authority, answer)) {
    return null
  }
  if (answer.result.kind !== operation.kind) {
    throw new Error(`journal work reader answered ${answer.result.kind} for ${operation.kind}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the named result's discriminant was checked above.
  return answer.result as JournalWorkAnswer<K>
}

export type JournalSqlWorkFrame<T> = {
  answer: JournalSqlWorkResult
  value: T
  /** Whether live authority and the adopted cursor still match this frame. */
  current: () => boolean
}

/** One attempt: the caller's rows and current work from one reader snapshot, validated once
 *  against live authority. `cached` is reused only when the rows' snapshot is its own. Null when
 *  authority moved during the read. */
export async function readJournalSqlWorkFrame<T>(
  journal: WorkAnswerJournal,
  capture: () => JournalCurrentWorkAuthority | null,
  read: (work: JournalDomainHistoryWork) => Promise<{ value: T; work?: JournalSqlWorkResult }>,
  cached?: JournalSqlWorkResult
): Promise<JournalSqlWorkFrame<T> | null> {
  const captured = capture()
  if (!captured) {
    return null
  }
  const authority = copyJournalCurrentWorkAuthority(captured)
  const frame = await read({
    read: { authority, operation: { kind: 'state' } },
    ...(cached
      ? { unlessAt: { cursor: cached.cursor, physicalCursor: cached.physicalCursor } }
      : {})
  })
  const answer = frame.work ?? cached
  if (!answer) {
    return null
  }
  const current = () => {
    const live = capture()
    return live !== null && journalSqlWorkAnswerIsCurrent(journal, () => live, authority, answer)
  }
  return current() ? { answer, value: frame.value, current } : null
}
