import { JournalSqlOwner } from './journal-sql-owner'

export async function journalDatabaseHoldsSessions(databasePath: string): Promise<boolean> {
  const reader = new JournalSqlOwner(databasePath, { reader: true })
  try {
    await reader.opened()
    return await reader.connection.probe()
  } finally {
    await reader.close()
  }
}
