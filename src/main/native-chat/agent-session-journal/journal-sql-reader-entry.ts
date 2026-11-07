import { parentPort, workerData } from 'node:worker_threads'
import Database from '../../sqlite/sync-database'
import { readJournalSqlHistoryPage } from './journal-sql-history-page'
import { journalSqlFailure } from './journal-sql-failure'
import type { JournalSqlReaderRequest, JournalSqlReaderReply } from './journal-sql-reader-pool'

if (!parentPort || typeof workerData?.filename !== 'string') {
  throw new Error('journal SQL reader requires a database path and parent port')
}
const port = parentPort
let db: Database.Database | undefined
function reply(message: JournalSqlReaderReply): void {
  port.postMessage(message)
}
try {
  db = new Database(workerData.filename, { readonly: true, fileMustExist: true, timeout: 5000 })
  if (String(db.pragma('journal_mode', { simple: true })).toLowerCase() !== 'wal') {
    throw new Error('journal SQL reader requires WAL mode')
  }
  reply({ type: 'ready' })
} catch (error) {
  reply({ type: 'failed', error: journalSqlFailure(error) })
  db?.close()
  db = undefined
  port.close()
}
port.on('message', ({ id, request }: JournalSqlReaderRequest) => {
  try {
    if (!db) {
      throw new Error('journal SQL reader is unavailable')
    }
    reply({ type: 'page', id, result: readJournalSqlHistoryPage(db, request) })
  } catch (error) {
    reply({ type: 'failed', id, error: journalSqlFailure(error) })
  }
})
