import type { AiVaultSession } from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  addPreviewMessage,
  finalizeSession,
  createAccumulator,
  timestampIso
} from './session-scanner-accumulator'
import { normalizeTitleText } from './session-scanner-text-normalization'
import { extractString, timestampMs } from './session-scanner-values'
import {
  detectHermesSessionSchema,
  hermesEffectiveTimeExpr,
  openHermesReadonlyDatabase,
  type HermesSessionSchema
} from './session-scanner-hermes-sqlite-list'
import { splitHermesSqliteCandidate } from './session-scanner-hermes-sqlite-paths'
import type { FileWithMtime } from './session-scanner-types'
import type SyncDatabase from '../sqlite/sync-database'
import { columnExists } from '../opencode-usage/schema-helpers'

type HermesSessionRow = Record<string, unknown> & {
  id: string
  started_at: number
  ended_at: number | null
  effective_at: number
}

type HermesPreviewRow = {
  content: string
  timestamp: number
}

function optionalColumn(db: SyncDatabase, columnName: string): string {
  return columnExists(db, 'sessions', columnName) ? `s.${columnName}` : 'NULL'
}

function optionalNumberColumn(db: SyncDatabase, columnName: string): string {
  return columnExists(db, 'sessions', columnName) ? `COALESCE(s.${columnName}, 0)` : '0'
}

function sessionQuery(db: SyncDatabase, schema: HermesSessionSchema): string {
  const archivedPredicate = schema.hasArchived ? 'AND COALESCE(s.archived, 0) = 0' : ''
  const effectiveTime = hermesEffectiveTimeExpr(schema)
  return `SELECT s.id,
                 s.started_at,
                 ${schema.hasEndedAt ? 's.ended_at' : 'NULL'} AS ended_at,
                 ${effectiveTime} AS effective_at,
                 ${optionalColumn(db, 'title')} AS title,
                 ${optionalColumn(db, 'display_name')} AS display_name,
                 ${optionalColumn(db, 'model')} AS model,
                 ${optionalColumn(db, 'cwd')} AS cwd,
                 ${optionalColumn(db, 'git_branch')} AS git_branch,
                 ${optionalColumn(db, 'git_repo_root')} AS git_repo_root,
                 ${optionalColumn(db, 'source')} AS session_source,
                 ${optionalColumn(db, 'billing_provider')} AS provider,
                 ${optionalColumn(db, 'profile_name')} AS profile_name,
                 ${optionalNumberColumn(db, 'message_count')} AS message_count,
                 ${optionalNumberColumn(db, 'input_tokens')} AS input_tokens,
                 ${optionalNumberColumn(db, 'output_tokens')} AS output_tokens,
                 ${optionalNumberColumn(db, 'cache_read_tokens')} AS cache_read_tokens,
                 ${optionalNumberColumn(db, 'cache_write_tokens')} AS cache_write_tokens,
                 ${optionalNumberColumn(db, 'reasoning_tokens')} AS reasoning_tokens
          FROM sessions s
          WHERE s.id = ? ${archivedPredicate}
          LIMIT 1`
}

function firstUserPreviewQuery(schema: HermesSessionSchema): string | null {
  if (!schema.hasFirstUserPreview) {
    return null
  }
  return `SELECT content, timestamp
          FROM messages
          WHERE session_id = ? AND role = 'user' AND content IS NOT NULL
          ORDER BY timestamp ASC, id ASC
          LIMIT 1`
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function rowTimestamp(row: HermesSessionRow): number {
  return timestampMs(row.effective_at)
}

function rowToSession(
  row: HermesSessionRow,
  dbPath: string,
  platform: NodeJS.Platform,
  preview: HermesPreviewRow | undefined,
  profileName?: string | null
): AiVaultSession | null {
  const sessionId = row.id.trim()
  const createdAt = timestampIso(row.started_at)
  const updatedAt = timestampIso(rowTimestamp(row))
  const cwd = extractString(row.cwd)
  const title =
    normalizeTitleText(extractString(row.display_name) ?? '') ||
    normalizeTitleText(extractString(row.title) ?? '') ||
    `Hermes ${sessionId.slice(0, 8)}`
  const accumulator = createAccumulator({
    agent: 'hermes',
    file: {
      path: dbPath,
      mtimeMs: rowTimestamp(row),
      modifiedAt: updatedAt ?? new Date(0).toISOString()
    } satisfies FileWithMtime,
    sessionId
  })
  accumulator.title = title
  accumulator.cwd = cwd
  accumulator.branch = extractString(row.git_branch)
  accumulator.model = extractString(row.model)
  accumulator.createdAt = createdAt
  accumulator.updatedAt = updatedAt
  accumulator.messageCount = numberValue(row.message_count)
  accumulator.totalTokens =
    numberValue(row.input_tokens) +
    numberValue(row.output_tokens) +
    numberValue(row.cache_read_tokens) +
    numberValue(row.cache_write_tokens) +
    numberValue(row.reasoning_tokens)
  if (preview && typeof preview.content === 'string') {
    addPreviewMessage(accumulator, {
      role: 'user',
      text: preview.content,
      timestamp: preview.timestamp
    })
  }
  const finalized = finalizeSession(accumulator, platform, {
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    profileName: profileName ?? extractString(row.profile_name)
  })
  if (!finalized) {
    return null
  }
  return {
    ...finalized,
    storage: 'sqlite',
    gitRepoRoot: extractString(row.git_repo_root),
    provider: extractString(row.provider),
    sessionSource: extractString(row.session_source),
    profileName: profileName ?? extractString(row.profile_name)
  }
}

export async function parseHermesSqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  profileName?: string | null
}): Promise<AiVaultSession | null> {
  let db: SyncDatabase | null = null
  try {
    db = openHermesReadonlyDatabase(args.dbPath)
    const schema = detectHermesSessionSchema(db)
    if (!schema) {
      return null
    }
    const row = db.prepare(sessionQuery(db, schema)).get(args.sessionId) as
      | HermesSessionRow
      | undefined
    if (!row || typeof row.id !== 'string') {
      return null
    }
    const previewSql = firstUserPreviewQuery(schema)
    const preview = previewSql
      ? (db.prepare(previewSql).get(args.sessionId) as HermesPreviewRow | undefined)
      : undefined
    return rowToSession(row, args.dbPath, args.platform, preview, args.profileName)
  } finally {
    db?.close()
  }
}

export function parseHermesCandidatePath(
  candidatePath: string
): { dbPath: string; sessionId: string } | null {
  return splitHermesSqliteCandidate(candidatePath)
}
