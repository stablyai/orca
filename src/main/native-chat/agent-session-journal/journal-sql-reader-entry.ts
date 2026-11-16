import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  journalOrchestrationAttached,
  markJournalOrchestrationAttached
} from './journal-failure-authority'
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
  openJournalLegacySource
} from './database/journal-legacy-source'

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
let originalHasOutcomes: boolean | undefined
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
    const authorityPath = join(dirname(workerData.originalFilename), 'orchestration.db')
    if (!journalOrchestrationAttached(db) && existsSync(authorityPath)) {
      const authorityUrl = pathToFileURL(authorityPath)
      authorityUrl.searchParams.set('mode', 'ro')
      db.prepare('ATTACH DATABASE ? AS orchestration_authority').run(authorityUrl.href)
      markJournalOrchestrationAttached(db)
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
        if (operation.operation.kind === 'failed-candidates') {
          const after = operation.operation.after ?? ''
          const candidates = db
            .prepare(`SELECT DISTINCT i.session_id FROM journal_items i INDEXED BY journal_failed_session_candidates
            JOIN journal_chat_state h ON h.session_id=i.session_id AND h.epoch=i.epoch
            WHERE i.hidden=0 AND i.queue_failed_outcome=1 AND i.queue_failed_at>0
              AND i.session_id>? ORDER BY i.session_id LIMIT 32`)
            .all(after)
          if (!original && existsSync(workerData.originalFilename)) {
            original = openJournalLegacySource(workerData.originalFilename, { timeout: 5000 })
          }
          originalHasOutcomes ??= !!original
            ?.prepare("SELECT 1 FROM sqlite_schema WHERE name='journal_outcome_epochs'")
            .get()
          const legacy =
            (originalHasOutcomes ? original : undefined)
              ?.prepare(`SELECT e.session_id FROM journal_outcome_epochs e
            WHERE e.session_id>? AND EXISTS(SELECT 1 FROM journal_outcomes q INDEXED BY journal_outcome_keys
              WHERE q.generation=e.generation AND q.field='queue.cards' AND q.deleted=0
                AND json_extract(q.value_json,'$[1].state')='waiting'
                AND NOT EXISTS(SELECT 1 FROM journal_outcomes newer INDEXED BY journal_outcome_keys
                  WHERE newer.generation=q.generation AND newer.field=q.field AND newer.entry_key=q.entry_key AND newer.seq>q.seq))
            ORDER BY e.session_id LIMIT 32`)
              .all(after) ?? []
          const sessionIds = [
            ...new Set([...candidates, ...legacy].map((row) => String(row.session_id)))
          ]
            .sort()
            .slice(0, 32)
          reply({ type: 'database', id, result: { kind: 'failed-candidates', sessionIds } })
          break
        }
        reply({ type: 'database', id, result: readJournalSqlDatabase(db, operation.operation) })
        break
      case 'conversion-prepare': {
        // Each frozen-source read is its own short statement; no snapshot spans the restore.
        if (!original && existsSync(workerData.originalFilename)) {
          original = openJournalLegacySource(workerData.originalFilename, { timeout: 5000 })
        }
        const prepared = original
          ? (prepareJournalDomainImport(original, operation.sessionId) ??
            prepareEmptyConversion(original, operation.sessionId))
          : null
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
