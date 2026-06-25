import type { AiVaultSession, AiVaultSessionPreviewMessage } from '../../shared/ai-vault-types'
import {
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import { normalizeTitleText } from './session-scanner-values'
import SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

// Why: OpenCode 1.17.x migrated session storage from per-session JSON files
// to a single SQLite DB at ~/.local/share/opencode/opencode.db. This module
// parses individual sessions from the DB into AiVaultSession objects. The
// discovery layer (listing candidates) lives in
// session-scanner-opencode-sqlite-discovery.ts.

const OPENCODE_SQLITE_PREVIEW_LIMIT = 5

type SessionRow = {
  id: string
  title: string | null
  directory: string | null
  time_created: number
  time_updated: number
  model_json: string | null
  agent: string | null
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  cost: number
  message_count: number
}

type PreviewRow = {
  role: string | null
  part_data: string
  time_created: number
  summary_title: string | null
  summary_body: string | null
}

function openReadonlyDatabase(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
  // Why: belt-and-suspenders guard so a bug in the SELECT list can never
  // mutate the user's opencode.db.
  db.pragma('query_only = ON')
  return db
}

function canReadOpenCodeSessions(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'session') &&
    columnExists(db, 'session', 'time_created') &&
    columnExists(db, 'session', 'time_updated')
  )
}

function sessionColumnSelect(db: SyncDatabase, columnName: string): string {
  return columnExists(db, 'session', columnName) ? `s.${columnName}` : 'NULL'
}

function sessionNumberColumnSelect(db: SyncDatabase, columnName: string): string {
  return columnExists(db, 'session', columnName) ? `s.${columnName}` : '0'
}

function canCountOpenCodeMessages(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'message') &&
    columnExists(db, 'message', 'session_id') &&
    columnExists(db, 'message', 'data')
  )
}

function buildSessionQuery(db: SyncDatabase): string {
  const messageCountSubquery = canCountOpenCodeMessages(db)
    ? `(SELECT COUNT(*) FROM message m
        WHERE m.session_id = s.id
          AND json_extract(m.data, '$.role') IN ('user','assistant'))`
    : '0'
  return `SELECT s.id,
                 ${sessionColumnSelect(db, 'title')} AS title,
                 ${sessionColumnSelect(db, 'directory')} AS directory,
                 s.time_created,
                 s.time_updated,
                 ${sessionColumnSelect(db, 'model')} AS model_json,
                 ${sessionColumnSelect(db, 'agent')} AS agent,
                 ${sessionNumberColumnSelect(db, 'tokens_input')} AS tokens_input,
                 ${sessionNumberColumnSelect(db, 'tokens_output')} AS tokens_output,
                 ${sessionNumberColumnSelect(db, 'tokens_reasoning')} AS tokens_reasoning,
                 ${sessionNumberColumnSelect(db, 'tokens_cache_read')} AS tokens_cache_read,
                 ${sessionNumberColumnSelect(db, 'cost')} AS cost,
                 ${messageCountSubquery} AS message_count
          FROM session s
          WHERE s.id = ?
          LIMIT 1`
}

function extractModelId(modelJson: string | null): string | null {
  if (!modelJson) {
    return null
  }
  try {
    const parsed = JSON.parse(modelJson) as unknown
    const record =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    if (!record) {
      return null
    }
    // Why: OpenCode 1.17.x stores model as {"id":"glm-5.2","providerID":"..."}.
    // Older schemas used {"modelID":"..."}; accept both.
    return (
      (typeof record.id === 'string' && record.id.trim()) ||
      (typeof record.modelID === 'string' && record.modelID.trim()) ||
      null
    )
  } catch {
    return null
  }
}

function mapPreviewRole(role: string | null): AiVaultSessionPreviewMessage['role'] {
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') {
    return role
  }
  return 'unknown'
}

function extractPartText(partData: string): string | null {
  try {
    const parsed = JSON.parse(partData) as unknown
    const record =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    if (!record) {
      return null
    }
    if (typeof record.text === 'string') {
      return record.text
    }
    return null
  } catch {
    return null
  }
}

function buildPreviewQuery(db: SyncDatabase): string | null {
  if (
    !canCountOpenCodeMessages(db) ||
    !tableExists(db, 'part') ||
    !columnExists(db, 'message', 'id') ||
    !columnExists(db, 'part', 'message_id') ||
    !columnExists(db, 'part', 'time_created') ||
    !columnExists(db, 'part', 'data')
  ) {
    return null
  }
  return `SELECT json_extract(m.data, '$.role') AS role,
                 p.data AS part_data,
                 p.time_created,
                 json_extract(m.data, '$.summary.title') AS summary_title,
                 json_extract(m.data, '$.summary.body') AS summary_body
          FROM message m
          JOIN part p ON p.message_id = m.id
          WHERE m.session_id = ?
            AND json_extract(m.data, '$.role') IN ('user','assistant')
            AND json_extract(p.data, '$.type') = 'text'
          ORDER BY p.time_created DESC
          LIMIT ?`
}

/**
 * Parse a single OpenCode session from the SQLite database into an
 * `AiVaultSession`. Reads session metadata (title, cwd, model, tokens, cost)
 * and up to 5 preview messages by joining the `message` and `part` tables.
 * The database is opened read-only with `PRAGMA query_only = ON` as a
 * belt-and-suspenders guard against mutations.
 * @param args.dbPath - Absolute path to the opencode.db file.
 * @param args.sessionId - The session ID (primary key in the `session` table).
 * @param args.platform - The platform to use for resume command generation.
 * @returns The parsed `AiVaultSession`, or `null` if the session does not exist
 *   or the database lacks the required schema.
 */
export async function parseOpenCodeSqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
}): Promise<AiVaultSession | null> {
  const { dbPath, sessionId, platform } = args
  let db: SyncDatabase | null = null
  try {
    db = openReadonlyDatabase(dbPath)
    if (!canReadOpenCodeSessions(db)) {
      return null
    }
    const row = db.prepare(buildSessionQuery(db)).get(sessionId) as SessionRow | undefined
    if (!row || row.id !== sessionId) {
      return null
    }

    const mtimeMs =
      typeof row.time_updated === 'number' && row.time_updated > 0
        ? row.time_updated
        : row.time_created
    // Why: discovery uses a synthetic db#session path only for parser routing.
    // The UI's log open/reveal actions need a real filesystem path.
    const accumulator = createAccumulator({
      agent: 'opencode',
      file: {
        path: dbPath,
        mtimeMs,
        modifiedAt: new Date(mtimeMs).toISOString()
      },
      sessionId
    })
    accumulator.title = normalizeTitleText(row.title ?? '')
    accumulator.cwd = row.directory
    accumulator.model = extractModelId(row.model_json)
    accumulator.totalTokens =
      (row.tokens_input ?? 0) + (row.tokens_output ?? 0) + (row.tokens_reasoning ?? 0)
    accumulator.messageCount = row.message_count ?? 0
    updateTimeline(accumulator, row.time_created)
    updateTimeline(accumulator, row.time_updated)

    const previewSql = buildPreviewQuery(db)
    if (previewSql) {
      const previewRows = db
        .prepare(previewSql)
        .all(sessionId, OPENCODE_SQLITE_PREVIEW_LIMIT) as PreviewRow[]
      // Why: query returns newest-first; push in chronological order so the
      // accumulator's ring buffer keeps the newest OPENCODE_SQLITE_PREVIEW_LIMIT
      // messages.
      for (let i = previewRows.length - 1; i >= 0; i--) {
        const previewRow = previewRows[i]
        if (!previewRow) {
          continue
        }
        const text = extractPartText(previewRow.part_data)
        if (!text) {
          continue
        }
        addPreviewMessage(accumulator, {
          role: mapPreviewRole(previewRow.role),
          text,
          timestamp: previewRow.time_created
        })
        if (previewRow.role === 'user' && !accumulator.title) {
          accumulator.title =
            normalizeTitleText(previewRow.summary_title ?? '') ||
            normalizeTitleText(previewRow.summary_body ?? '')
        }
      }
    }

    return finalizeSession(accumulator, platform)
  } finally {
    db?.close()
  }
}
