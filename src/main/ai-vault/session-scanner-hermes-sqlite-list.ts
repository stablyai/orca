import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { timestampMs } from './session-scanner-values'
import { buildHermesSqliteCandidatePath } from './session-scanner-hermes-sqlite-paths'
import type { SessionFileCandidate } from './session-scanner-types'
import SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import { errorMessage } from './session-scanner-values'

export type HermesSessionSchema = {
  hasEndedAt: boolean
  hasEndReason: boolean
  hasArchived: boolean
  hasParentSessionId: boolean
  hasModelConfig: boolean
  hasMessagesTimestamp: boolean
  hasFirstUserPreview: boolean
}

type HermesListRow = {
  id: string
  started_at: number
  ended_at: number | null
  effective_at: number
}

export function openHermesReadonlyDatabase(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true, timeout: 250 })
  db.pragma('query_only = ON')
  return db
}

export function detectHermesSessionSchema(db: SyncDatabase): HermesSessionSchema | null {
  if (
    !tableExists(db, 'sessions') ||
    !columnExists(db, 'sessions', 'id') ||
    !columnExists(db, 'sessions', 'source') ||
    !columnExists(db, 'sessions', 'started_at')
  ) {
    return null
  }
  return {
    hasEndedAt: columnExists(db, 'sessions', 'ended_at'),
    hasEndReason: columnExists(db, 'sessions', 'end_reason'),
    hasArchived: columnExists(db, 'sessions', 'archived'),
    hasParentSessionId: columnExists(db, 'sessions', 'parent_session_id'),
    hasModelConfig: columnExists(db, 'sessions', 'model_config'),
    hasMessagesTimestamp:
      tableExists(db, 'messages') &&
      columnExists(db, 'messages', 'session_id') &&
      columnExists(db, 'messages', 'timestamp'),
    hasFirstUserPreview:
      tableExists(db, 'messages') &&
      columnExists(db, 'messages', 'session_id') &&
      columnExists(db, 'messages', 'role') &&
      columnExists(db, 'messages', 'content') &&
      columnExists(db, 'messages', 'timestamp')
  }
}

function safeModelConfigExtract(alias: string, path: string): string {
  const modelConfig = `COALESCE(${alias}.model_config, '{}')`
  return `(CASE WHEN json_valid(${modelConfig}) THEN json_extract(${modelConfig}, '${path}') END)`
}

function branchPredicate(schema: HermesSessionSchema): string {
  const predicates: string[] = []
  if (schema.hasModelConfig) {
    predicates.push(`${safeModelConfigExtract('s', '$._branched_from')} IS NOT NULL`)
  }
  if (schema.hasEndReason && schema.hasEndedAt) {
    predicates.push(
      'EXISTS (SELECT 1 FROM sessions p WHERE p.id = s.parent_session_id ' +
        "AND p.end_reason = 'branched' AND s.started_at >= p.ended_at)"
    )
  }
  return predicates.length > 0 ? `(${predicates.join(' OR ')})` : '0'
}

function compressionPredicate(schema: HermesSessionSchema): string {
  if (!schema.hasEndReason) {
    return '0'
  }
  const excludedMarkers = schema.hasModelConfig
    ? `AND ${safeModelConfigExtract('s', '$._branched_from')} IS NULL ` +
      `AND ${safeModelConfigExtract('s', '$._delegate_from')} IS NULL`
    : ''
  return `EXISTS (SELECT 1 FROM sessions p WHERE p.id = s.parent_session_id AND p.end_reason = 'compression' ${excludedMarkers})`
}

function listablePredicate(schema: HermesSessionSchema): string {
  if (!schema.hasParentSessionId) {
    return schema.hasEndReason ? "COALESCE(s.end_reason, '') <> 'compression'" : '1'
  }
  const rootPredicate = schema.hasEndReason
    ? "(s.parent_session_id IS NULL AND COALESCE(s.end_reason, '') <> 'compression')"
    : 's.parent_session_id IS NULL'
  const children = [branchPredicate(schema), compressionPredicate(schema)].join(' OR ')
  return `(${rootPredicate} OR (${children}))`
}

function listQuery(schema: HermesSessionSchema, limit?: number): string {
  const baseTime = schema.hasEndedAt
    ? 'CASE WHEN s.ended_at IS NOT NULL AND s.ended_at > s.started_at THEN s.ended_at ELSE s.started_at END'
    : 's.started_at'
  const effectiveTime = schema.hasMessagesTimestamp
    ? `MAX(${baseTime}, COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id), ${baseTime}))`
    : baseTime
  return `SELECT s.id, s.started_at, ${schema.hasEndedAt ? 's.ended_at' : 'NULL'} AS ended_at,
                 ${effectiveTime} AS effective_at
          FROM sessions s
          WHERE COALESCE(s.source, '') <> 'tool'
            AND ${listablePredicate(schema)}
            ${schema.hasModelConfig ? `AND ${safeModelConfigExtract('s', '$._delegate_from')} IS NULL` : ''}
            ${schema.hasArchived ? 'AND COALESCE(s.archived, 0) = 0' : ''}
          ORDER BY effective_at DESC, s.started_at DESC, s.id DESC${
            typeof limit === 'number' ? '\n          LIMIT ?' : ''
          }`
}

function rowMtimeMs(row: HermesListRow): number {
  return timestampMs(row.effective_at)
}

function rowToCandidate(
  row: HermesListRow,
  dbPath: string,
  profileName?: string | null
): SessionFileCandidate {
  const mtimeMs = rowMtimeMs(row)
  return {
    agent: 'hermes' as AiVaultAgent,
    file: {
      path: buildHermesSqliteCandidatePath(dbPath, row.id),
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    },
    codexHome: null,
    ...(profileName ? { profileName } : {})
  }
}

export async function listHermesSqliteSessions(args: {
  dbPaths: readonly string[]
  limit?: number
  profileNames?: readonly (string | null)[]
  issues: AiVaultScanIssue[]
}): Promise<SessionFileCandidate[]> {
  const candidates: SessionFileCandidate[] = []
  for (const [dbIndex, dbPath] of args.dbPaths.entries()) {
    let db: SyncDatabase | null = null
    try {
      db = openHermesReadonlyDatabase(dbPath)
      const schema = detectHermesSessionSchema(db)
      if (!schema) {
        args.issues.push({
          agent: 'hermes',
          path: dbPath,
          message: 'Hermes state.db has no compatible sessions table; history was skipped.'
        })
        continue
      }
      const query = listQuery(schema, args.limit)
      const rows = (
        typeof args.limit === 'number' ? db.prepare(query).all(args.limit) : db.prepare(query).all()
      ) as HermesListRow[]
      const profileName = args.profileNames?.[dbIndex] ?? null
      candidates.push(
        ...rows
          .filter((row) => Number.isFinite(rowMtimeMs(row)))
          .map((row) => rowToCandidate(row, dbPath, profileName))
      )
    } catch (err) {
      args.issues.push({ agent: 'hermes', path: dbPath, message: errorMessage(err) })
    } finally {
      db?.close()
    }
  }
  return candidates.sort(
    (left, right) =>
      right.file.mtimeMs - left.file.mtimeMs || left.file.path.localeCompare(right.file.path)
  )
}
