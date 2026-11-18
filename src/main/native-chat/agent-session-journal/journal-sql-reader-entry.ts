import { JournalForkPreparation } from './journal-fork-preparation'
import { parentPort, workerData } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import Database from '../../sqlite/sync-database'
import { journalSqlFailure, journalSqlSourceFailure } from './journal-sql-failure'
import type { JournalSqlReaderRequest, JournalSqlReaderReply } from './journal-sql-reader-protocol'
import { prepareJournalDomainImport, type JournalDomainImport } from './journal-domain-import'
import { readJournalSqlDatabase } from './journal-sql-database-read'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { readJournalDomainHistoryFrame } from './journal-domain-history-page'
import { journalDomainImportState } from './journal-domain-import-rows'
import {
  journalLegacyChatRevision,
  journalLegacyConversionSource,
  openJournalLegacySource
} from './database/journal-legacy-source'
import { compareJournalLegacyChat } from './database/journal-legacy-compare'
import { installWorkerSendLedger } from '../../worker-threads/worker-send-ledger'
import { limitJournalReaderReply } from './journal-sql-reader-reply-limit'

installWorkerSendLedger('orca-journal-sql-reader')

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
  // An oversized reply fails its request instead of the receiving thread running out of memory.
  port.postMessage(limitJournalReaderReply(message))
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
        reply({
          type: 'page',
          id,
          ...readJournalDomainHistoryFrame(db, operation.request, operation.work)
        })
        break
      case 'point':
        reply({ type: 'point', id, result: readJournalSqlPoint(db, operation.request) })
        break
      case 'database':
        reply({ type: 'database', id, result: readJournalSqlDatabase(db, operation.operation) })
        break
      case 'conversion-prepare': {
        // Each frozen-source read is its own short statement; no snapshot spans the restore.
        const source = openOriginal()
        const from = journalLegacyConversionSource(db, operation.sessionId)
        const prepared = source
          ? (prepareJournalDomainImport(source, from) ?? prepareEmptyConversion(source, from))
          : null
        if (prepared) {
          const { pages, ...header } = prepared
          conversions.set(id, pages)
          // A copy takes the original chat's history; the original's revision stays the original's.
          const conversion =
            from === operation.sessionId
              ? header
              : { ...header, sessionId: operation.sessionId, sourceRevision: null }
          reply({ type: 'prepared', id, conversion })
        } else {
          reply({ type: 'prepared', id, conversion: null })
        }
        break
      }
      case 'legacy-compare': {
        const result = compareJournalLegacyChat(openOriginal, db, operation.sessionId)
        reply({ type: 'legacy-compare', id, result })
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
    let retire = operation.kind === 'fork-prepare'
    if (fork) {
      try {
        fork.preparation.close()
      } catch {
        retire = true
      }
    }
    if (retire) {
      reply({ type: 'failed', error: journalSqlFailure(error) })
      try {
        db?.close()
      } catch {}
      db = undefined
      port.close()
      return
    }
    reply({
      type: 'failed',
      id,
      error:
        operation.kind === 'conversion-prepare'
          ? journalSqlSourceFailure(error)
          : journalSqlFailure(error)
    })
  }
})

function openOriginal(): Database.Database | undefined {
  if (!original && existsSync(workerData.originalFilename)) {
    original = openJournalLegacySource(workerData.originalFilename, { timeout: 5000 })
  }
  return original
}

/** Preserve empty saved epochs independently of legacy-source retirement. */
function prepareEmptyConversion(
  source: Database.Database,
  sessionId: string
): JournalDomainImport | null {
  const session = source
    .prepare('SELECT workspace_id,epoch FROM journal_sessions WHERE session_id=?')
    .get(sessionId)
  if (!session) {
    return null
  }
  for (const table of ['journal_rows', 'queued_messages', 'journal_outcome_epochs']) {
    if (source.prepare(`SELECT 1 FROM ${table} WHERE session_id=? LIMIT 1`).get(sessionId)) {
      return null
    }
  }
  return {
    sessionId,
    workspaceId: String(session.workspace_id),
    epoch: String(session.epoch),
    sourceRevision: journalLegacyChatRevision(source, sessionId),
    head: {
      lastSequence: 0,
      highestFence: 0,
      contextBoundary: 0,
      lastActivityAt: 0,
      derivedTurnItemId: null,
      historyOrigin: null,
      queueFailureBoundary: 0,
      queuePauseMarks: { latestStop: null, resumedSequence: 0, reopenedSequence: 0 }
    },
    pages: (function* () {
      yield* []
    })()
  }
}
