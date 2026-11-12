import { parentPort } from 'node:worker_threads'
import { handleOpenCodeSqliteRequest } from '../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-dispatch'
import type { OpenCodeSqliteWorkerRequest } from '../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-protocol'
import { handleForeignSqliteReaderRequest } from './foreign-sqlite-reader-dispatch'
import type {
  ForeignSqliteWorkerRequest,
  ForeignSqliteReaderResponse
} from './foreign-sqlite-reader-protocol'

import type SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import { openOpenCodeDatabaseReadonly } from '../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite-open'
import { buildHermesSqliteCandidatePath } from '../ai-vault/scanners/hermes/session-scanner-hermes-sqlite-paths'
import { SessionNewestFiles } from '../ai-vault/session-newest-files'
import { createAiVaultScopeCwdMatcher } from '../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'
import {
  readSessionRow,
  sessionMtimeMs,
  timestampMs,
  type HermesSessionsQuery,
  type HermesSessionsResult
} from './hermes-sessions-result'

// Keep OpenCode dispatch separate because SSH/WSL relays bundle it without the other readers.

if (!parentPort) {
  throw new Error('Foreign SQLite reader worker must run with a parent port.')
}
const port = parentPort

type ReaderRequest = OpenCodeSqliteWorkerRequest | ForeignSqliteWorkerRequest

function isOpenCodeRequest(request: ReaderRequest): request is OpenCodeSqliteWorkerRequest {
  return (
    request.kind === 'list' ||
    request.kind === 'parse' ||
    request.kind === 'capture' ||
    request.kind === 'native-page' ||
    request.kind === 'native-signal' ||
    request.kind === 'fork-coverage'
  )
}

function handle(request: ReaderRequest): Promise<ForeignSqliteReaderResponse> {
  if (request.kind === 'hermesSessions') {
    try {
      return Promise.resolve({ id: request.id, ok: true, value: readHermesSessions(request) })
    } catch (error) {
      return Promise.resolve({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return isOpenCodeRequest(request)
    ? handleOpenCodeSqliteRequest(request)
    : Promise.resolve(handleForeignSqliteReaderRequest(request))
}

port.on('message', (request: ReaderRequest) => {
  void handle(request).then((response) => {
    try {
      port.postMessage(response)
    } catch {
      // Reply with a serialization failure instead of leaving the client waiting for its timeout.
      port.postMessage({
        id: request.id,
        ok: false,
        error: 'Foreign SQLite reader result could not be serialized.'
      })
    }
  })
})

/**
 * Checks whether the database contains the Hermes sessions table and valid ID column.
 */
function canReadHermesSessions(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'sessions') &&
    (columnExists(db, 'sessions', 'id') || columnExists(db, 'sessions', 'session_id'))
  )
}

type SessionColumns = {
  idCol: string
  titleCol: string
  cwdCol: string
  modelCol: string
  createdCol: string
  updatedCol: string
}

/**
 * Dynamically maps column names for sessions table based on schema variants.
 */
function resolveSessionColumns(db: SyncDatabase): SessionColumns {
  const idCol = columnExists(db, 'sessions', 'id') ? 'id' : 'session_id'
  const titleCol = columnExists(db, 'sessions', 'title') ? 'title' : 'NULL'
  const cwdCol = columnExists(db, 'sessions', 'cwd') ? 'cwd' : 'NULL'
  const modelCol = columnExists(db, 'sessions', 'model') ? 'model' : 'NULL'
  const createdCol = columnExists(db, 'sessions', 'created_at')
    ? 'created_at'
    : columnExists(db, 'sessions', 'session_start')
      ? 'session_start'
      : columnExists(db, 'sessions', 'started_at')
        ? 'started_at'
        : 'NULL'
  // Why: the shipped schema has no updated_at — last_activity_at is rarely written and ended_at
  // only on a clean exit, so take whichever of them the row actually carries.
  const activityCols = ['last_activity_at', 'ended_at'].filter((col) =>
    columnExists(db, 'sessions', col)
  )
  const updatedCol = columnExists(db, 'sessions', 'updated_at')
    ? 'updated_at'
    : columnExists(db, 'sessions', 'last_updated')
      ? 'last_updated'
      : activityCols.length > 0
        ? `COALESCE(${[...activityCols, createdCol].join(', ')})`
        : createdCol
  return { idCol, titleCol, cwdCol, modelCol, createdCol, updatedCol }
}

/**
 * Builds the predicate that drops zero-turn session shells created by CLI startup,
 * so they do not clutter the AI Vault session list.
 */
function messagesPredicateFor(db: SyncDatabase, idCol: string): string {
  const msgSessionIdCol =
    tableExists(db, 'messages') && columnExists(db, 'messages', 'session_id') ? 'session_id' : null
  return msgSessionIdCol
    ? `AND EXISTS (SELECT 1 FROM messages WHERE ${msgSessionIdCol} = sessions.${idCol})`
    : ''
}

function lastMessageTimes(db: SyncDatabase, sessionId?: string): Map<string, number> {
  const times = new Map<string, number>()
  if (!tableExists(db, 'messages') || !columnExists(db, 'messages', 'session_id')) {
    return times
  }
  const column = ['created_at', 'timestamp'].find((name) => columnExists(db, 'messages', name))
  if (!column) {
    return times
  }
  const statement = db.prepare(`SELECT session_id, ${column} AS timestamp FROM messages
    ${sessionId === undefined ? '' : 'WHERE session_id = ?'}`)
  const rows = sessionId === undefined ? statement.iterate() : statement.iterate(sessionId)
  // Validate and normalize before taking the maximum so bad cells cannot hide newer messages.
  for (const row of rows) {
    const time = timestampMs(row.timestamp)
    if (typeof row.session_id === 'string' && time !== null) {
      times.set(row.session_id, Math.max(times.get(row.session_id) ?? time, time))
    }
  }
  return times
}

/**
 * Builds the SQL SELECT query string used to discover Hermes sessions.
 */
function buildSessionListQuery(db: SyncDatabase): string {
  const { idCol, titleCol, cwdCol, modelCol, createdCol, updatedCol } = resolveSessionColumns(db)
  const messagesPredicate = messagesPredicateFor(db, idCol)

  return `SELECT ${idCol} AS id,
                 ${titleCol} AS title,
                 ${cwdCol} AS cwd,
                 ${modelCol} AS model,
                 ${createdCol} AS created_at,
                 ${updatedCol} AS updated_at
          FROM sessions
          WHERE 1=1 ${messagesPredicate}`
}

function readHermesSessions(query: HermesSessionsQuery): HermesSessionsResult {
  const db = openOpenCodeDatabaseReadonly(query.dbPath)
  try {
    const readable = canReadHermesSessions(db)
    switch (query.operation) {
      case 'ids': {
        const ids: string[] = []
        if (readable) {
          const idCol = columnExists(db, 'sessions', 'id') ? 'id' : 'session_id'
          const sql = `SELECT ${idCol} AS id FROM sessions
                       WHERE 1=1 ${messagesPredicateFor(db, idCol)}`
          for (const row of db.prepare(sql).all()) {
            if (typeof row.id === 'string' && row.id) {
              ids.push(row.id)
            }
          }
        }
        return { operation: 'ids', ids }
      }
      case 'list': {
        const newest = new SessionNewestFiles(query.limit)
        if (readable) {
          const inScope = query.scopePaths?.length
            ? createAiVaultScopeCwdMatcher(query.scopePaths)
            : null
          const messageTimes = lastMessageTimes(db)
          // Normalize both timestamp formats before applying the recency cap.
          for (const rawRow of db.prepare(buildSessionListQuery(db)).iterate()) {
            const row = readSessionRow(rawRow)
            if (!row?.id || (inScope && !inScope(row.cwd, query.dbPath))) {
              continue
            }
            const mtimeMs = sessionMtimeMs(row, messageTimes.get(row.id))
            newest.add({
              path: buildHermesSqliteCandidatePath(query.dbPath, row.id),
              mtimeMs,
              modifiedAt: new Date(mtimeMs).toISOString()
            })
          }
        }
        return { operation: 'list', files: newest.newest() }
      }
      case 'session': {
        if (!readable) {
          return { operation: 'session', session: null }
        }
        const { idCol, titleCol, cwdCol, modelCol, createdCol, updatedCol } =
          resolveSessionColumns(db)
        const sql = `SELECT ${idCol} AS id,
                            ${titleCol} AS title,
                            ${cwdCol} AS cwd,
                            ${modelCol} AS model,
                            ${createdCol} AS created_at,
                            ${updatedCol} AS updated_at
                     FROM sessions
                     WHERE ${idCol} = ?
                     LIMIT 1`
        const row = readSessionRow(db.prepare(sql).get(query.sessionId))
        if (!row) {
          return { operation: 'session', session: null }
        }
        const mtimeMs = sessionMtimeMs(row, lastMessageTimes(db, row.id).get(row.id))
        const messages: { role: unknown; content: unknown }[] = []
        if (tableExists(db, 'messages') && columnExists(db, 'messages', 'session_id')) {
          const roleCol = columnExists(db, 'messages', 'role') ? 'role' : 'NULL'
          const contentCol = columnExists(db, 'messages', 'content') ? 'content' : 'NULL'
          const orderCol = columnExists(db, 'messages', 'id')
            ? 'id'
            : columnExists(db, 'messages', 'created_at')
              ? 'created_at'
              : columnExists(db, 'messages', 'timestamp')
                ? 'timestamp'
                : 'rowid'
          const msgQuery = `SELECT ${roleCol} AS role, ${contentCol} AS content
                            FROM messages
                            WHERE session_id = ?
                            ORDER BY ${orderCol} ASC`
          for (const message of db.prepare(msgQuery).iterate(query.sessionId)) {
            messages.push({ role: message.role, content: message.content })
          }
        }
        return { operation: 'session', session: { row, mtimeMs, messages } }
      }
    }
  } finally {
    db.close()
  }
}
