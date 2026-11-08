import type {
  AiVaultScanIssue,
  AiVaultSession
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  createAccumulator,
  finalizeSession,
  updateTimeline
} from '../../session-scanner-accumulator'
import { addSessionContent } from '../../session-scanner-messages'
import { buildHermesSqliteCandidatePath } from './session-scanner-hermes-sqlite-paths'
import type { SessionFileCandidate } from '../../session-scanner-types'
import type { TranscriptMessageSink } from '../../transcripts/session-transcript-consumers'
import { errorMessage, extractContentText } from '../../session-scanner-values'
import type SyncDatabase from '../../../sqlite/sync-database'
import type { SqliteRow } from '../../../sqlite/sqlite-statement'
import { columnExists, tableExists } from '../../../opencode-usage/schema-helpers'
import { SessionNewestFiles } from '../../session-newest-files'
import { createAiVaultScopeCwdMatcher } from '../../../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'
import { openOpenCodeDatabaseReadonly } from '../opencode/sqlite/session-scanner-opencode-sqlite-open'

// Why: Hermes migrated session storage to a SQLite database (state.db).
// This module lists and parses individual sessions from the DB into AiVaultSession objects.

/**
 * Checks whether the database contains the Hermes sessions table and valid ID column.
 */
function canReadHermesSessions(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'sessions') &&
    (columnExists(db, 'sessions', 'id') || columnExists(db, 'sessions', 'session_id'))
  )
}

/**
 * Normalizes an unknown timestamp value (seconds string or number) to milliseconds.
 */
function timestampMs(val: unknown): number | null {
  let parsed = Number.NaN
  if (typeof val === 'number') {
    parsed = val < 1e11 ? val * 1000 : val
  } else if (typeof val === 'string') {
    const numeric = Number(val)
    if (val.trim() !== '' && Number.isFinite(numeric)) {
      parsed = numeric < 1e11 ? numeric * 1000 : numeric
    } else {
      parsed = Date.parse(val)
    }
  }
  return Number.isNaN(new Date(parsed).getTime()) ? null : parsed
}

type SessionRow = {
  id: string
  title: string | null
  cwd: string | null
  model: string | null
  created_at: unknown
  updated_at: unknown
}

function readSessionRow(row: SqliteRow | undefined): SessionRow | null {
  if (!row || typeof row.id !== 'string') {
    return null
  }
  return {
    id: row.id,
    title: typeof row.title === 'string' ? row.title : null,
    cwd: typeof row.cwd === 'string' ? row.cwd : null,
    model: typeof row.model === 'string' ? row.model : null,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
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

function sessionMtimeMs(row: SessionRow, lastMessageAt: number | undefined): number {
  const sessionTime = timestampMs(row.updated_at) ?? timestampMs(row.created_at)
  return sessionTime === null
    ? (lastMessageAt ?? Date.now())
    : Math.max(sessionTime, lastMessageAt ?? sessionTime)
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

/**
 * Reads the session IDs the SQLite scanner actually surfaces, for deduplication.
 * Unlimited but filtered exactly like the list query: a shell the migration left
 * without messages must not evict the legacy JSON file that still holds the turns.
 */
export function listHermesSqliteSessionIds(dbPaths: readonly string[]): Set<string> {
  const ids = new Set<string>()
  for (const dbPath of dbPaths) {
    let db: SyncDatabase | null = null
    try {
      db = openOpenCodeDatabaseReadonly(dbPath)
      if (!canReadHermesSessions(db)) {
        continue
      }
      const idCol = columnExists(db, 'sessions', 'id') ? 'id' : 'session_id'
      const query = `SELECT ${idCol} AS id FROM sessions
                     WHERE 1=1 ${messagesPredicateFor(db, idCol)}`
      const rows = db.prepare(query).all()
      for (const row of rows) {
        if (typeof row.id === 'string' && row.id) {
          ids.add(row.id)
        }
      }
    } catch {
      // Ignore unreadable database paths
    } finally {
      db?.close()
    }
  }
  return ids
}

/**
 * List Hermes sessions from one or more SQLite databases as synthetic
 * `SessionFileCandidate` entries. Each candidate's file path is a synthetic
 * `<dbPath>#<sessionId>` string that the parser dispatcher routes to
 * `parseHermesSqliteSession`.
 * @param args.dbPaths - Absolute paths to state.db files to scan.
 * @param args.limit - Maximum number of sessions to return per database.
 * @param args.issues - Collected scan issues to append errors to.
 * @returns Array of synthetic candidates sorted by recency.
 */
export async function listHermesSqliteSessions(args: {
  dbPaths: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
  scopePaths?: readonly string[]
}): Promise<SessionFileCandidate[]> {
  const candidates: SessionFileCandidate[] = []
  for (const dbPath of args.dbPaths) {
    let db: SyncDatabase | null = null
    try {
      db = openOpenCodeDatabaseReadonly(dbPath)
      if (!canReadHermesSessions(db)) {
        continue
      }
      const newest = new SessionNewestFiles(args.limit)
      const inScope = args.scopePaths?.length ? createAiVaultScopeCwdMatcher(args.scopePaths) : null
      const messageTimes = lastMessageTimes(db)
      // Normalize both timestamp formats before applying the recency cap.
      for (const rawRow of db.prepare(buildSessionListQuery(db)).iterate()) {
        const row = readSessionRow(rawRow)
        if (!row?.id || (inScope && !inScope(row.cwd, dbPath))) {
          continue
        }
        const mtimeMs = sessionMtimeMs(row, messageTimes.get(row.id))
        newest.add({
          path: buildHermesSqliteCandidatePath(dbPath, row.id),
          mtimeMs,
          modifiedAt: new Date(mtimeMs).toISOString()
        })
      }
      candidates.push(
        ...newest.newest().map((file) => ({ agent: 'hermes' as const, file, codexHome: null }))
      )
    } catch (err) {
      if (!args.issues.some((issue) => issue.agent === 'hermes' && issue.path === dbPath)) {
        args.issues.push({ agent: 'hermes', path: dbPath, message: errorMessage(err) })
      }
    } finally {
      db?.close()
    }
  }
  candidates.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs)
  return candidates
}

/**
 * Parse a single Hermes session from the SQLite database into an `AiVaultSession`.
 * Reads session metadata (title, cwd, model, timeline) and preview messages from
 * the `sessions` and `messages` tables.
 * @param args.dbPath - Absolute path to the state.db file.
 * @param args.sessionId - The session ID (primary key in the `sessions` table).
 * @param args.platform - The platform to use for resume command generation.
 * @param args.messages - Where the parser publishes every decoded message.
 * @returns The parsed `AiVaultSession`, or `null` if the session does not exist.
 */
export async function parseHermesSqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  messages?: TranscriptMessageSink
}): Promise<AiVaultSession | null> {
  let db: SyncDatabase | null = null
  // Let read failures propagate so the transcript reader reports an incomplete read.
  try {
    db = openOpenCodeDatabaseReadonly(args.dbPath)
    if (!canReadHermesSessions(db)) {
      return null
    }

    const { idCol, titleCol, cwdCol, modelCol, createdCol, updatedCol } = resolveSessionColumns(db)

    const query = `SELECT ${idCol} AS id,
                          ${titleCol} AS title,
                          ${cwdCol} AS cwd,
                          ${modelCol} AS model,
                          ${createdCol} AS created_at,
                          ${updatedCol} AS updated_at
                   FROM sessions
                   WHERE ${idCol} = ?
                   LIMIT 1`

    const row = readSessionRow(db.prepare(query).get(args.sessionId))
    if (!row) {
      return null
    }

    const mtimeMs = sessionMtimeMs(row, lastMessageTimes(db, row.id).get(row.id))
    const file = {
      path: buildHermesSqliteCandidatePath(args.dbPath, args.sessionId),
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    }

    const accumulator = createAccumulator({
      agent: 'hermes',
      file,
      sessionId: args.sessionId,
      messages: args.messages
    })

    if (row.model) {
      accumulator.model = row.model
    }
    if (row.cwd) {
      accumulator.cwd = row.cwd
    }
    if (row.title) {
      accumulator.title = row.title
    }

    updateTimeline(accumulator, timestampMs(row.created_at))
    updateTimeline(accumulator, mtimeMs)

    if (tableExists(db, 'messages')) {
      const msgSessionIdCol = columnExists(db, 'messages', 'session_id') ? 'session_id' : null
      if (msgSessionIdCol) {
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
                          WHERE ${msgSessionIdCol} = ?
                          ORDER BY ${orderCol} ASC`

        const messages = db.prepare(msgQuery).all(args.sessionId)

        for (const msg of messages) {
          const role = msg.role
          if (role === 'user' || role === 'assistant') {
            accumulator.messageCount++
            if (role === 'user' && !accumulator.title) {
              accumulator.title = extractContentText(msg.content)
            }
            addSessionContent(accumulator, role, msg.content)
          }
        }
      }
    }

    return finalizeSession(accumulator, args.platform)
  } finally {
    db?.close()
  }
}
