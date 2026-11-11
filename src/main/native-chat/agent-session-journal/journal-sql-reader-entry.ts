import { JournalForkPreparation } from './journal-fork-preparation'
import { parentPort, workerData } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import Database from '../../sqlite/sync-database'
import { journalSqlFailure } from './journal-sql-failure'
import type { JournalSqlReaderRequest, JournalSqlReaderReply } from './journal-sql-reader-protocol'
import { prepareJournalDomainImport, type JournalDomainImport } from './journal-domain-import'
import { readJournalSqlDatabase } from './journal-sql-database-read'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { readJournalDomainHistoryPage } from './journal-domain-history-page'
import { journalDomainImportState } from './journal-domain-import-rows'

if (
  !parentPort ||
  typeof workerData?.filename !== 'string' ||
  typeof workerData.originalFilename !== 'string'
) {
  throw new Error('journal SQL reader requires a database path and parent port')
}
const port = parentPort
let db: Database.Database | undefined
let original: Database.Database | undefined
let fork: { id: number; preparation: JournalForkPreparation } | undefined
const conversions = new Map<number, JournalDomainImport['pages']>()
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
    if (fork && !operation.kind.startsWith('fork-')) {
      throw new Error('fork reader is exclusively reserved')
    }
    switch (operation.kind) {
      case 'fork-prepare':
        if (fork || conversions.size) {
          throw new Error('fork reader reservation is not exclusive')
        }
        fork = { id, preparation: new JournalForkPreparation(db, operation.input) }
        reply({ type: 'fork-prepared', id })
        break
      case 'fork-next':
        if (fork?.id !== operation.preparationId) {
          throw new Error('fork reader preparation is no longer available')
        }
        reply({ type: 'fork-next', id, result: fork.preparation.next() })
        break
      case 'fork-release':
        if (fork?.id !== operation.preparationId) {
          throw new Error('fork reader preparation is no longer available')
        }
        fork.preparation.close()
        fork = undefined
        reply({ type: 'released', id })
        break
      case 'import-state':
        reply({
          type: 'import-state',
          id,
          state: journalDomainImportState(db, operation.sessionId)
        })
        break
      case 'domain-history':
        reply({ type: 'page', id, result: readJournalDomainHistoryPage(db, operation.request) })
        break
      case 'point':
        reply({ type: 'point', id, result: readJournalSqlPoint(db, operation.request) })
        break
      case 'database':
        reply({ type: 'database', id, result: readJournalSqlDatabase(db, operation.operation) })
        break
      case 'conversion-prepare': {
        // Each frozen-source read is its own short statement; no snapshot spans the restore.
        if (!original && existsSync(workerData.originalFilename)) {
          original = new Database(workerData.originalFilename, {
            readonly: true,
            fileMustExist: true,
            timeout: 5000
          })
        }
        const prepared = original ? prepareJournalDomainImport(original, operation.sessionId) : null
        if (prepared) {
          const { pages, ...header } = prepared
          conversions.set(id, pages)
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
    if (fork) {
      try {
        fork.preparation.close()
      } catch {
        reply({ type: 'failed', error: journalSqlFailure(error) })
        try {
          db?.close()
        } catch {}
        db = undefined
        port.close()
        return
      }
    }
    reply({ type: 'failed', id, error: journalSqlFailure(error) })
  }
})
