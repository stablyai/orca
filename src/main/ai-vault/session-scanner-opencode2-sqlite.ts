import type { AiVaultSession, AiVaultSessionPreviewMessage } from '../../shared/ai-vault-types'
import {
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import {
  normalizeFullFirstUserPromptText,
  shouldCaptureFullFirstUserPrompt
} from './session-scanner-first-user-prompt'
import { normalizeTitleText } from './session-scanner-values'
import SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

// Why: opencode2 (beta) stores sessions in a channel-scoped SQLite DB with its
// own schema — `session_v2` rows plus `session_message` rows whose `data`
// column holds tagged message JSON (user/assistant/system/tool/…), with no
// `part` table like opencode v1. The v2 schema is explicitly unstable during
// beta, so every read is column-guarded and any drift fails soft to a null
// session. Electron-free so the worker entry can import it.

const OPENCODE2_SESSION_TABLE = 'session_v2'
const OPENCODE2_MESSAGE_TABLE = 'session_message'

const OPENCODE2_PREVIEW_LIMIT = 5
// Why: v2 stores the full message JSON inline in one column, so the preview
// window can stay small; a heavy session's assistant content can still hold
// large tool blobs.
const OPENCODE2_PREVIEW_MESSAGE_WINDOW = 100

type SessionRow = {
  id: string
  title: string | null
  directory: string | null
  agent: string | null
  model: string | null
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  cost: number
  message_count: number
  time_created: number
  time_updated: number
}

type PreviewRow = {
  type: string | null
  data: string
  time_created: number
}

function openReadonlyDatabase(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  return db
}

function canReadOpenCode2Sessions(db: SyncDatabase): boolean {
  return (
    tableExists(db, OPENCODE2_SESSION_TABLE) &&
    columnExists(db, OPENCODE2_SESSION_TABLE, 'id') &&
    columnExists(db, OPENCODE2_SESSION_TABLE, 'time_created') &&
    columnExists(db, OPENCODE2_SESSION_TABLE, 'time_updated')
  )
}

function sessionColumnSelect(db: SyncDatabase, columnName: string): string {
  return columnExists(db, OPENCODE2_SESSION_TABLE, columnName) ? `s.${columnName}` : 'NULL'
}

function sessionNumberColumnSelect(db: SyncDatabase, columnName: string): string {
  return columnExists(db, OPENCODE2_SESSION_TABLE, columnName) ? `s.${columnName}` : '0'
}

function canCountOpenCode2Messages(db: SyncDatabase): boolean {
  return (
    tableExists(db, OPENCODE2_MESSAGE_TABLE) &&
    columnExists(db, OPENCODE2_MESSAGE_TABLE, 'session_id') &&
    columnExists(db, OPENCODE2_MESSAGE_TABLE, 'type') &&
    columnExists(db, OPENCODE2_MESSAGE_TABLE, 'data')
  )
}

// Why: preview and first-prompt queries additionally read time/ordering
// columns; a beta schema drift must fail soft to "no preview", not throw.
function canPreviewOpenCode2Messages(db: SyncDatabase): boolean {
  return (
    canCountOpenCode2Messages(db) &&
    columnExists(db, OPENCODE2_MESSAGE_TABLE, 'time_created') &&
    columnExists(db, OPENCODE2_MESSAGE_TABLE, 'seq')
  )
}

function buildSessionQuery(db: SyncDatabase): string {
  const messageCountSubquery = canCountOpenCode2Messages(db)
    ? `(SELECT COUNT(*) FROM ${OPENCODE2_MESSAGE_TABLE} m
        WHERE m.session_id = s.id
          AND m.type IN ('user','assistant'))`
    : '0'
  return `SELECT s.id,
                 ${sessionColumnSelect(db, 'title')} AS title,
                 ${sessionColumnSelect(db, 'directory')} AS directory,
                 ${sessionColumnSelect(db, 'agent')} AS agent,
                 ${sessionColumnSelect(db, 'model')} AS model,
                 ${sessionNumberColumnSelect(db, 'tokens_input')} AS tokens_input,
                 ${sessionNumberColumnSelect(db, 'tokens_output')} AS tokens_output,
                 ${sessionNumberColumnSelect(db, 'tokens_reasoning')} AS tokens_reasoning,
                 ${sessionNumberColumnSelect(db, 'tokens_cache_read')} AS tokens_cache_read,
                 ${sessionNumberColumnSelect(db, 'cost')} AS cost,
                 ${messageCountSubquery} AS message_count,
                 s.time_created,
                 s.time_updated
          FROM ${OPENCODE2_SESSION_TABLE} s
          WHERE s.id = ?
          LIMIT 1`
}

// Why: v2 stores the model ref as a text column. Newer builds serialize a
// Model.Ref JSON ({id, providerID}); older shapes may be a bare id string.
function extractModelId(modelText: string | null): string | null {
  if (!modelText) {
    return null
  }
  const trimmed = modelText.trim()
  if (!trimmed) {
    return null
  }
  if (!trimmed.startsWith('{')) {
    return trimmed
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const record =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    if (typeof record?.id === 'string' && record.id.trim()) {
      return record.id
    }
    if (typeof record?.modelID === 'string' && record.modelID.trim()) {
      return record.modelID
    }
  } catch {
    return null
  }
  return null
}

function mapPreviewRole(type: string | null): AiVaultSessionPreviewMessage['role'] {
  if (type === 'user' || type === 'assistant' || type === 'system' || type === 'tool') {
    return type
  }
  return 'unknown'
}

// Why: user messages carry `text` (string or array of strings); assistant
// messages carry `content` as an array of {type:'text'|'reasoning', text}.
function extractMessageText(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as unknown
    const record =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    if (!record) {
      return null
    }
    const text = record.text
    if (typeof text === 'string') {
      return text
    }
    if (Array.isArray(text)) {
      const parts = text.filter((part): part is string => typeof part === 'string')
      return parts.length > 0 ? parts.join('\n') : null
    }
    const content = record.content
    if (Array.isArray(content)) {
      const texts: string[] = []
      for (const item of content) {
        if (
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          (item as Record<string, unknown>).type === 'text' &&
          typeof (item as Record<string, unknown>).text === 'string'
        ) {
          texts.push((item as Record<string, unknown>).text as string)
        }
      }
      return texts.length > 0 ? texts.join('\n') : null
    }
    return null
  } catch {
    return null
  }
}

function readFirstUserPromptFromDb(db: SyncDatabase, sessionId: string): string | null {
  if (!canPreviewOpenCode2Messages(db)) {
    return null
  }
  try {
    const rows = db
      .prepare(
        `SELECT data FROM ${OPENCODE2_MESSAGE_TABLE}
         WHERE session_id = ?
           AND type = 'user'
           AND data LIKE '%"type":"user"%'
         ORDER BY time_created ASC, seq ASC
         LIMIT 1`
      )
      .all(sessionId) as { data: string }[]
    const text = rows[0] ? extractMessageText(rows[0].data) : null
    return text ? normalizeFullFirstUserPromptText(text) : null
  } catch {
    return null
  }
}

function buildPreviewQuery(db: SyncDatabase): string | null {
  if (!canPreviewOpenCode2Messages(db)) {
    return null
  }
  return `SELECT type, data, time_created
          FROM (SELECT type, data, time_created, seq FROM ${OPENCODE2_MESSAGE_TABLE}
                WHERE session_id = ?
                  AND type IN ('user','assistant')
                ORDER BY time_created DESC, seq DESC
                LIMIT ${OPENCODE2_PREVIEW_MESSAGE_WINDOW})
          ORDER BY time_created DESC, seq DESC
          LIMIT ?`
}

/**
 * Parse a single opencode2 session from the channel-scoped SQLite database
 * into an `AiVaultSession`. Reads session metadata (title, cwd, model, tokens,
 * cost) and up to 5 preview messages from the `session_message` table. The
 * database is opened read-only with `PRAGMA query_only = ON`; any schema drift
 * from the beta builds fails soft to `null`.
 * @param args.dbPath - Absolute path to the opencode2 (opencode-next.db) file.
 * @param args.sessionId - Primary key in the `session_v2` table.
 * @param args.platform - The platform to use for resume command generation.
 * @returns The parsed `AiVaultSession`, or `null` if the session does not exist
 *   or the database lacks the required schema.
 */
export async function parseOpenCode2SqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
}): Promise<AiVaultSession | null> {
  const { dbPath, sessionId, platform } = args
  let db: SyncDatabase | null = null
  try {
    db = openReadonlyDatabase(dbPath)
    if (!canReadOpenCode2Sessions(db)) {
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
    const accumulator = createAccumulator({
      agent: 'opencode2',
      file: {
        path: dbPath,
        mtimeMs,
        modifiedAt: new Date(mtimeMs).toISOString()
      },
      sessionId
    })
    accumulator.title = normalizeTitleText(row.title ?? '')
    accumulator.cwd = row.directory
    accumulator.model = extractModelId(row.model)
    accumulator.totalTokens =
      (row.tokens_input ?? 0) + (row.tokens_output ?? 0) + (row.tokens_reasoning ?? 0)
    accumulator.messageCount = row.message_count ?? 0
    updateTimeline(accumulator, row.time_created)
    updateTimeline(accumulator, row.time_updated)

    const previewSql = buildPreviewQuery(db)
    if (previewSql) {
      const probedRows = db
        .prepare(previewSql)
        .all(sessionId, OPENCODE2_PREVIEW_LIMIT + 1) as PreviewRow[]
      if (probedRows.length > OPENCODE2_PREVIEW_LIMIT) {
        accumulator.previewMessagesTruncated = true
      }
      const previewRows = probedRows.slice(0, OPENCODE2_PREVIEW_LIMIT)
      for (let i = previewRows.length - 1; i >= 0; i--) {
        const previewRow = previewRows[i]
        if (!previewRow) {
          continue
        }
        const text = extractMessageText(previewRow.data)
        if (!text) {
          continue
        }
        addPreviewMessage(accumulator, {
          role: mapPreviewRole(previewRow.type),
          text,
          timestamp: previewRow.time_created,
          seedFirstUserPrompt: false
        })
      }
    }

    if (shouldCaptureFullFirstUserPrompt()) {
      accumulator.firstUserPrompt = readFirstUserPromptFromDb(db, sessionId)
    }

    return finalizeSession(accumulator, platform)
  } finally {
    db?.close()
  }
}
