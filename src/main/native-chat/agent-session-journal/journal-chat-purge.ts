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

/** Finish purges an exit or error cut short, for chats whose workspace `owns` proves deleted. */
export async function purgeOrphanedJournalChats(
  database: JournalSqlDatabase,
  owns: (workspaceId: string) => Promise<boolean>
): Promise<number> {
  if (database.readOnly) {
    return 0
  }
  const found = await database.serialize('', (writer) => writer.maintain({ kind: 'chat-orphans' }))
  const orphans = found && typeof found === 'object' && 'orphans' in found ? found.orphans : []
  let purged = 0
  for (const orphan of orphans) {
    if (await owns(orphan.workspaceId)) {
      await purgeForgottenJournalChat(database, orphan.sessionId)
      purged++
    }
  }
  return purged
}
