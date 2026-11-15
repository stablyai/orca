import { setImmediate } from 'node:timers/promises'
import type { JournalSqlDatabase } from './database/journal-sql-database'

/** Delete a forgotten chat's rows a page at a time; periodic maintenance reclaims the freed pages. */
export function purgeForgottenJournalChat(
  database: JournalSqlDatabase,
  sessionId: string
): Promise<void> {
  if (database.readOnly) {
    return Promise.resolve()
  }
  return database.serialize(sessionId, async (writer) => {
    for (;;) {
      const page = await writer.maintain({ kind: 'chat-purge', sessionId })
      if (!page || typeof page !== 'object' || !('more' in page) || !page.more) {
        return
      }
      await setImmediate()
    }
  })
}
