import { vi } from 'vitest'
import { JournalSqlOwner } from './journal-sql-owner'

/** Inject the same SQLite failure at each typed read boundary that previously prepared that table. */
export function failTestJournalReads(domain: 'records' | 'journal', error: Error): () => void {
  const request = JournalSqlOwner.prototype.request
  const spy = vi.spyOn(JournalSqlOwner.prototype, 'request').mockImplementation(function (
    this: JournalSqlOwner,
    command
  ) {
    if (command.type === 'read') {
      const read = command.read
      const matches =
        domain === 'records'
          ? read.kind === 'receipts' || (read.kind === 'sql' && read.sql.includes('agent_session_'))
          : read.kind === 'source' ||
            read.kind === 'outcomes' ||
            (read.kind === 'sql' && read.sql.includes('journal_'))
      if (matches) {
        return Promise.reject(error)
      }
    }
    return request.call(this, command)
  })
  return () => spy.mockRestore()
}
