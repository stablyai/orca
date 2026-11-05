import { JournalSqlOwner } from './journal-sql-owner'

export async function journalDatabaseHoldsSessions(
  databasePath: string,
  workerPath?: string
): Promise<boolean> {
  const reader = new JournalSqlOwner(databasePath, { reader: true, workerPath })
  try {
    await reader.opened()
    return await reader.connection.probe()
  } catch {
    // Failed reads cannot prove absence; physical closure must still succeed before an opener proceeds.
    return true
  } finally {
    await reader.close()
  }
}
