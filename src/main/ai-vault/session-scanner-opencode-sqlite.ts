import type { AiVaultSession, AiVaultSessionPreviewMessage } from '../../shared/ai-vault-types'
import { createAccumulator, finalizeSession, updateTimeline } from './session-scanner-accumulator'
import { addPreviewMessage } from './session-scanner-messages'
import {
  normalizeFullFirstUserPromptText,
  shouldCaptureFullFirstUserPrompt
} from './session-scanner-first-user-prompt'
import { readOpenCodeDatabase } from './session-scanner-opencode-sqlite-open'
import { readPartDataRow, readSessionRow } from './session-scanner-opencode-sqlite-rows'
import {
  canCountOpenCodeMessages,
  canReadOpenCodeMessageParts
} from './session-scanner-opencode-sqlite-schema'
import { normalizeTitleText } from './session-scanner-values'
import { zcodeVisibleMessageFilter } from './session-scanner-zcode-visibility'
import { zcodeTranscriptOrder } from './session-scanner-zcode-order'
import type SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

const OPENCODE_SQLITE_PREVIEW_LIMIT = 5
// Bound previews to recent messages to avoid scanning large historical tool blobs; worker timeout caps residual work.
const OPENCODE_SQLITE_PREVIEW_MESSAGE_WINDOW = 100
// Bounds a pathological single message; a real typed prompt is a handful of parts.
const FIRST_USER_PROMPT_PART_LIMIT = 512

type PreviewRow = {
  role: string | null
  part_data: string
  time_created: number
  summary_title: string | null
  summary_body: string | null
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

function buildSessionQuery(db: SyncDatabase, agent: 'opencode' | 'zcode'): string {
  const messageCountSubquery = canCountOpenCodeMessages(db)
    ? `(SELECT COUNT(*) FROM message m
        WHERE m.session_id = s.id
          ${zcodeVisibleMessageFilter(agent)}
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
    // Accept current id and older modelID model-reference spellings.
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

export function extractPartText(partData: string): string | null {
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

function readFirstUserPromptFromOpenCodeDb(
  db: SyncDatabase,
  sessionId: string,
  agent: 'opencode' | 'zcode'
): string | null {
  if (!canReadOpenCodeMessageParts(db)) {
    return null
  }

  try {
    // Restrict parts to the earliest user message with text; spanning turns would contaminate the first prompt.
    const rows = db
      .prepare(
        `SELECT p.data AS part_data
         FROM part p
         WHERE p.message_id = (
                 SELECT m.id
                 FROM message m
                 JOIN part fp ON fp.message_id = m.id
                 WHERE m.session_id = ?
                   ${zcodeVisibleMessageFilter(agent)}
                   AND json_extract(m.data, '$.role') = 'user'
                   AND json_extract(fp.data, '$.type') = 'text'
                 ORDER BY ${zcodeTranscriptOrder(db, agent, 'message', 'm', 'ASC')}
                 LIMIT 1
               )
           AND json_extract(p.data, '$.type') = 'text'
         ORDER BY ${zcodeTranscriptOrder(db, agent, 'part', 'p', 'ASC')}
         LIMIT ${FIRST_USER_PROMPT_PART_LIMIT}`
      )
      .all(sessionId)
      .map(readPartDataRow)
      .filter((row): row is { part_data: string } => row !== null)

    const parts: string[] = []
    for (const row of rows) {
      const text = extractPartText(row.part_data)
      if (text) {
        parts.push(text)
      }
    }
    if (parts.length === 0) {
      return null
    }
    return normalizeFullFirstUserPromptText(parts.join('\n'))
  } catch {
    return null
  }
}

function buildPreviewQuery(db: SyncDatabase, agent: 'opencode' | 'zcode'): string | null {
  if (!canReadOpenCodeMessageParts(db)) {
    return null
  }
  return `SELECT json_extract(m.data, '$.role') AS role,
                 p.data AS part_data,
                 p.time_created,
                 json_extract(m.data, '$.summary.title') AS summary_title,
                 json_extract(m.data, '$.summary.body') AS summary_body
          FROM (SELECT ${agent === 'zcode' ? 'm.rowid AS rowid, m.*' : 'm.id, m.data'} FROM message m
                WHERE m.session_id = ?
                ${zcodeVisibleMessageFilter(agent)}
                ORDER BY ${zcodeTranscriptOrder(db, agent, 'message', 'm', 'DESC')}
                LIMIT ${OPENCODE_SQLITE_PREVIEW_MESSAGE_WINDOW}) m
          JOIN part p ON p.message_id = m.id
          WHERE json_extract(m.data, '$.role') IN ('user','assistant')
            AND json_extract(p.data, '$.type') = 'text'
          ORDER BY ${
            agent === 'zcode'
              ? `${zcodeTranscriptOrder(db, agent, 'message', 'm', 'DESC')}, ${zcodeTranscriptOrder(db, agent, 'part', 'p', 'DESC')}`
              : 'p.time_created DESC'
          }
          LIMIT ?`
}

/** Read session metadata and a bounded preview; absent sessions or required schema yield null. */
export async function parseOpenCodeSqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  agent?: 'opencode' | 'zcode'
}): Promise<AiVaultSession | null> {
  return readOpenCodeDatabase({
    dbPath: args.dbPath,
    read: (db) => readOpenCodeSqliteSession({ db, ...args })
  })
}

export function readOpenCodeSqliteSession(args: {
  db: SyncDatabase
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  agent?: 'opencode' | 'zcode'
}): AiVaultSession | null {
  const { db, dbPath, sessionId, platform } = args
  if (!canReadOpenCodeSessions(db)) {
    return null
  }
  const agent = args.agent ?? 'opencode'
  const row = readSessionRow(db.prepare(buildSessionQuery(db, agent)).get(sessionId))
  if (!row || row.id !== sessionId) {
    return null
  }

  const mtimeMs =
    typeof row.time_updated === 'number' && row.time_updated > 0
      ? row.time_updated
      : row.time_created
  // Keep a real database path for UI open/reveal actions; synthetic db#session paths only route parsing.
  const accumulator = createAccumulator({
    agent: args.agent ?? 'opencode',
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

  const previewSql = buildPreviewQuery(db, agent)
  if (previewSql) {
    // Probe one extra row because SQL windowing prevents the accumulator from detecting omitted previews.
    const probedRows = db
      .prepare(previewSql)
      .all(sessionId, OPENCODE_SQLITE_PREVIEW_LIMIT + 1) as PreviewRow[]
    if (probedRows.length > OPENCODE_SQLITE_PREVIEW_LIMIT) {
      accumulator.previewMessagesTruncated = true
    }
    const previewRows = probedRows.slice(0, OPENCODE_SQLITE_PREVIEW_LIMIT)
    // Reverse newest-first query results before pushing into the chronological preview ring.
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

  // On-demand copy needs the earliest real prompt, which may lie outside the recent preview window.
  if (shouldCaptureFullFirstUserPrompt()) {
    accumulator.firstUserPrompt = readFirstUserPromptFromOpenCodeDb(db, sessionId, agent)
  }

  return finalizeSession(accumulator, platform)
}
