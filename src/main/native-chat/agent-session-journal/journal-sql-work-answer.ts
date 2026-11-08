import type { SqlAgentSessionJournal } from './journal-sql-store'
import {
  copyJournalCurrentWorkAuthority,
  type JournalCurrentWorkAuthority
} from './journal-observer-read'
import type { JournalWorkRead, JournalWorkAnswer } from './journal-work-read'
import { sameJournalCursor } from './replay/journal-cursor'
import { AgentSessionJournalError } from './writing/journal-write-guards'

/** Validate the worker snapshot and live owners before returning action evidence. */
export async function readJournalSqlWorkAnswer<K extends JournalWorkRead['kind']>(
  journal: Pick<
    SqlAgentSessionJournal,
    | 'isClosed'
    | 'identity'
    | 'reads'
    | 'cursor'
    | 'physicalCursor'
    | 'observationHandle'
    | 'openingCursor'
  >,
  capture: () => JournalCurrentWorkAuthority,
  operation: Extract<JournalWorkRead, { kind: K }>
): Promise<JournalWorkAnswer<K>> {
  const requested = structuredClone(operation)
  for (;;) {
    if (journal.isClosed) {
      throw new AgentSessionJournalError(
        'journal_closed',
        `the journal for ${journal.identity.sessionId} is closed`
      )
    }
    const authority = copyJournalCurrentWorkAuthority(capture())
    const signature = JSON.stringify(authority)
    const answer = await journal.reads.work({ authority, operation: requested })
    if (
      !journal.isClosed &&
      sameJournalCursor(answer.cursor, journal.cursor()) &&
      sameJournalCursor(answer.physicalCursor, journal.physicalCursor()) &&
      authority.handle === journal.observationHandle() &&
      sameJournalCursor(authority.openedThrough, journal.openingCursor()) &&
      JSON.stringify(copyJournalCurrentWorkAuthority(capture())) === signature &&
      JSON.stringify(answer.authority) === signature
    ) {
      if (answer.result.kind !== operation.kind) {
        throw new Error(`journal work reader answered ${answer.result.kind} for ${operation.kind}`)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the named result's discriminant was checked above.
      return answer.result as JournalWorkAnswer<K>
    }
  }
}
