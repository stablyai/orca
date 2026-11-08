import { parentPort, workerData } from 'node:worker_threads'
import Database from '../../sqlite/sync-database'
import { readJournalSqlHistoryPage } from './journal-sql-history-page'
import { journalSqlFailure } from './journal-sql-failure'
import type { JournalSqlReaderRequest, JournalSqlReaderReply } from './journal-sql-reader-protocol'
import { prepareJournalSqlConversion } from './journal-sql-conversion'
import { journalSqlConversionPages } from './journal-sql-conversion-pages'
import { readJournalSqlDatabase } from './journal-sql-database-read'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { readJournalDomainHistoryPage } from './journal-domain-history-page'

if (!parentPort || typeof workerData?.filename !== 'string') {
  throw new Error('journal SQL reader requires a database path and parent port')
}
const port = parentPort
let db: Database.Database | undefined
const conversions = new Map<number, ReturnType<typeof journalSqlConversionPages>>()
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
port.on('message', ({ id, operation }: JournalSqlReaderRequest) => {
  try {
    if (!db) {
      throw new Error('journal SQL reader is unavailable')
    }
    switch (operation.kind) {
      case 'domain-history':
        reply({ type: 'page', id, result: readJournalDomainHistoryPage(db, operation.request) })
        break
      case 'point':
        reply({ type: 'point', id, result: readJournalSqlPoint(db, operation.request) })
        break
      case 'database':
        reply({ type: 'database', id, result: readJournalSqlDatabase(db, operation.operation) })
        break
      case 'history':
        reply({ type: 'page', id, result: readJournalSqlHistoryPage(db, operation.request) })
        break
      case 'conversion-prepare': {
        db.exec('BEGIN')
        let conversion: ReturnType<typeof prepareJournalSqlConversion>
        try {
          conversion = prepareJournalSqlConversion(db, operation.sessionId)
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
        if (conversion) {
          conversions.set(id, journalSqlConversionPages(conversion))
          const { tables: _tables, ...header } = conversion
          reply({ type: 'prepared', id, conversion: header })
        } else {
          reply({ type: 'prepared', id, conversion: null })
        }
        break
      }
      case 'conversion-page': {
        const pages = conversions.get(operation.conversionId)
        if (!pages) {
          throw new Error('journal conversion reader is no longer available')
        }
        const next = pages.next()
        if (next.done) {
          conversions.delete(operation.conversionId)
        }
        reply({ type: 'rows', id, page: next.done ? null : next.value })
        break
      }
      case 'conversion-release':
        conversions.delete(operation.conversionId)
        reply({ type: 'released', id })
        break
    }
  } catch (error) {
    reply({ type: 'failed', id, error: journalSqlFailure(error) })
  }
})
