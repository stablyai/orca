import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { journalSqlSourceFailure } from '../../agent-session-journal/journal-sql-failure'

/**
 * A corrupt journal fails status reads the same way until a commit or reopen moves it, so a
 * status sweep must not reread it every pass.
 */
export class CorruptJournalReads {
  private readonly failed = new WeakMap<SqlAgentSessionJournal, { at: string; error: unknown }>()

  async read<T>(journal: SqlAgentSessionJournal, read: () => Promise<T>): Promise<T> {
    const at = position(journal)
    const failed = this.failed.get(journal)
    if (failed?.at === at) {
      throw failed.error
    }
    try {
      return await read()
    } catch (error) {
      if (journalSqlSourceFailure(error).sourceContent === 'journalCorrupt') {
        this.failed.set(journal, { at, error })
      }
      throw error
    }
  }
}

function position(journal: SqlAgentSessionJournal): string {
  return JSON.stringify([journal.cursor(), journal.physicalCursor()])
}
