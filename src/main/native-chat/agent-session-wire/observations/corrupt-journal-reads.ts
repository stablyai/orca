import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { journalSqlSourceFailure } from '../../agent-session-journal/journal-sql-failure'

/**
 * A corrupt journal fails the same read the same way until a commit or reopen changes its key,
 * so a status sweep must not reread it every pass.
 */
export class CorruptJournalReads {
  private readonly failed = new WeakMap<SqlAgentSessionJournal, { key: string; error: unknown }>()

  throwIfKnown(journal: SqlAgentSessionJournal, key: string): void {
    const failed = this.failed.get(journal)
    if (failed?.key === key) {
      throw failed.error
    }
  }

  remember<T>(journal: SqlAgentSessionJournal, key: string, read: Promise<T>): Promise<T> {
    return read.catch((error: unknown) => {
      if (journalSqlSourceFailure(error).sourceContent === 'journalCorrupt') {
        this.failed.set(journal, { key, error })
      }
      throw error
    })
  }
}
