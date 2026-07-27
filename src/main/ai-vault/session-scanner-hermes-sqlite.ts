import { existsSync } from 'node:fs'
import type { AiVaultAgent, AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import { buildHermesSqliteCandidatePath } from './session-scanner-hermes-sqlite-paths'
import type { SessionFileCandidate } from './session-scanner-types'
import { errorMessage, extractContentText } from './session-scanner-values'
import SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

// Why: Hermes 0.19+ migrated session storage to a SQLite database at ~/.hermes/state.db.
// This module lists and parses individual sessions from the DB into AiVaultSession objects.

function openReadonlyDatabase(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
  // Why: query_only prevents accidental writes to the user's Hermes database.
  db.pragma('query_only = ON')
  return db
}

function canReadHermesSessions(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'sessions') &&
    (columnExists(db, 'sessions', 'id') || columnExists(db, 'sessions', 'session_id'))
  )
}

function timestampMs(val: unknown): number {
  if (typeof val === 'number') {
    return val < 1e11 ? val * 1000 : val
  }
  if (typeof val === 'string') {
    const parsed = Date.parse(val)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }
  return Date.now()
}

type SessionRow = {
  id: string
  title: string | null
  cwd: string | null
  model: string | null
  created_at: unknown
  updated_at: unknown
}

function buildSessionListQuery(db: SyncDatabase): string {
  const idCol = columnExists(db, 'sessions', 'id') ? 'id' : 'session_id'
  const titleCol = columnExists(db, 'sessions', 'title') ? 'title' : 'NULL'
  const cwdCol = columnExists(db, 'sessions', 'cwd') ? 'cwd' : 'NULL'
  const modelCol = columnExists(db, 'sessions', 'model') ? 'model' : 'NULL'
  const createdCol = columnExists(db, 'sessions', 'created_at')
    ? 'created_at'
    : columnExists(db, 'sessions', 'session_start')
      ? 'session_start'
      : 'NULL'
  const updatedCol = columnExists(db, 'sessions', 'updated_at')
    ? 'updated_at'
    : columnExists(db, 'sessions', 'last_updated')
      ? 'last_updated'
      : createdCol

  // Why: filter out zero-turn empty sessions that have no recorded messages in the messages table
  // so empty session shells created by CLI startup do not clutter the AI Vault session list.
  const msgSessionIdCol =
    tableExists(db, 'messages') && columnExists(db, 'messages', 'session_id') ? 'session_id' : null
  const messagesPredicate = msgSessionIdCol
    ? `AND EXISTS (SELECT 1 FROM messages WHERE ${msgSessionIdCol} = sessions.${idCol})`
    : ''

  return `SELECT ${idCol} AS id,
                 ${titleCol} AS title,
                 ${cwdCol} AS cwd,
                 ${modelCol} AS model,
                 ${createdCol} AS created_at,
                 ${updatedCol} AS updated_at
          FROM sessions
          WHERE 1=1 ${messagesPredicate}
          ORDER BY ${updatedCol} DESC
          LIMIT ?`
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
}): Promise<SessionFileCandidate[]> {
  const candidates: SessionFileCandidate[] = []
  for (const dbPath of args.dbPaths) {
    if (!existsSync(dbPath)) {
      continue
    }
    let db: SyncDatabase | null = null
    try {
      db = openReadonlyDatabase(dbPath)
      if (!canReadHermesSessions(db)) {
        continue
      }
      const rows = db.prepare(buildSessionListQuery(db)).all(args.limit) as SessionRow[]
      for (const row of rows) {
        if (!row.id) {
          continue
        }
        const mtimeMs = timestampMs(row.updated_at ?? row.created_at)
        candidates.push({
          agent: 'hermes' as AiVaultAgent,
          file: {
            path: buildHermesSqliteCandidatePath(dbPath, row.id),
            mtimeMs,
            modifiedAt: new Date(mtimeMs).toISOString()
          },
          codexHome: null
        })
      }
    } catch (err) {
      args.issues.push({
        agent: 'hermes',
        path: dbPath,
        message: errorMessage(err)
      })
    } finally {
      db?.close()
    }
  }
  return candidates
}

/**
 * Parse a single Hermes session from the SQLite database into an `AiVaultSession`.
 * Reads session metadata (title, cwd, model, timeline) and preview messages from
 * the `sessions` and `messages` tables.
 * @param args.dbPath - Absolute path to the state.db file.
 * @param args.sessionId - The session ID (primary key in the `sessions` table).
 * @param args.platform - The platform to use for resume command generation.
 * @returns The parsed `AiVaultSession`, or `null` if the session does not exist.
 */
export async function parseHermesSqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
}): Promise<AiVaultSession | null> {
  if (!existsSync(args.dbPath)) {
    return null
  }
  let db: SyncDatabase | null = null
  try {
    db = openReadonlyDatabase(args.dbPath)
    if (!canReadHermesSessions(db)) {
      return null
    }

    const idCol = columnExists(db, 'sessions', 'id') ? 'id' : 'session_id'
    const titleCol = columnExists(db, 'sessions', 'title') ? 'title' : 'NULL'
    const cwdCol = columnExists(db, 'sessions', 'cwd') ? 'cwd' : 'NULL'
    const modelCol = columnExists(db, 'sessions', 'model') ? 'model' : 'NULL'
    const createdCol = columnExists(db, 'sessions', 'created_at')
      ? 'created_at'
      : columnExists(db, 'sessions', 'session_start')
        ? 'session_start'
        : 'NULL'
    const updatedCol = columnExists(db, 'sessions', 'updated_at')
      ? 'updated_at'
      : columnExists(db, 'sessions', 'last_updated')
        ? 'last_updated'
        : createdCol

    const query = `SELECT ${idCol} AS id,
                          ${titleCol} AS title,
                          ${cwdCol} AS cwd,
                          ${modelCol} AS model,
                          ${createdCol} AS created_at,
                          ${updatedCol} AS updated_at
                   FROM sessions
                   WHERE ${idCol} = ?
                   LIMIT 1`

    const row = db.prepare(query).get(args.sessionId) as SessionRow | undefined
    if (!row) {
      return null
    }

    const mtimeMs = timestampMs(row.updated_at ?? row.created_at)
    const file = {
      path: buildHermesSqliteCandidatePath(args.dbPath, args.sessionId),
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    }

    const accumulator = createAccumulator({
      agent: 'hermes',
      file,
      sessionId: args.sessionId
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
    updateTimeline(accumulator, timestampMs(row.updated_at))

    if (tableExists(db, 'messages')) {
      const msgSessionIdCol = columnExists(db, 'messages', 'session_id') ? 'session_id' : null
      if (msgSessionIdCol) {
        const roleCol = columnExists(db, 'messages', 'role') ? 'role' : 'NULL'
        const contentCol = columnExists(db, 'messages', 'content') ? 'content' : 'NULL'
        const orderCol = columnExists(db, 'messages', 'created_at')
          ? 'created_at'
          : columnExists(db, 'messages', 'timestamp')
            ? 'timestamp'
            : columnExists(db, 'messages', 'id')
              ? 'id'
              : 'rowid'

        const msgQuery = `SELECT ${roleCol} AS role, ${contentCol} AS content
                          FROM messages
                          WHERE ${msgSessionIdCol} = ?
                          ORDER BY ${orderCol} ASC`

        const messages = db.prepare(msgQuery).all(args.sessionId) as {
          role: string | null
          content: string | null
        }[]

        for (const msg of messages) {
          const role = msg.role
          if (role === 'user' || role === 'assistant') {
            accumulator.messageCount++
            if (role === 'user' && !accumulator.title) {
              accumulator.title = extractContentText(msg.content)
            }
            addPreviewContent(accumulator, role, msg.content)
          }
        }
      }
    }

    return finalizeSession(accumulator, args.platform)
  } catch {
    return null
  } finally {
    db?.close()
  }
}
