import { join } from 'path'
import type { AiVaultAgent, AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'
import { buildOpenCodeSqliteCandidatePath } from './session-scanner-opencode-sqlite-paths'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import type { SessionFileCandidate, SessionFileDiscovery } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../sqlite/schema-helpers'

// Why: keep the SQLite discovery + dedup layer separate from the parser so
// each file stays under the max-lines lint rule and the discovery layer can
// be tested in isolation.

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

function openReadonlyDatabase(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
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

function buildSessionListQuery(db: SyncDatabase): string {
  const modelSelect = columnExists(db, 'session', 'model') ? 's.model' : 'NULL'
  const agentSelect = columnExists(db, 'session', 'agent') ? 's.agent' : 'NULL'
  const tokenColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read']
  const tokenSelects = tokenColumns
    .map((col) => (columnExists(db, 'session', col) ? `s.${col}` : '0'))
    .join(', ')
  const costSelect = columnExists(db, 'session', 'cost') ? 's.cost' : '0'
  const parentIdPredicate = columnExists(db, 'session', 'parent_id')
    ? 'AND s.parent_id IS NULL'
    : ''
  const archivedPredicate = columnExists(db, 'session', 'time_archived')
    ? 'AND s.time_archived IS NULL'
    : ''
  const messageCountSubquery = tableExists(db, 'message')
    ? `(SELECT COUNT(*) FROM message m
        WHERE m.session_id = s.id
          AND json_extract(m.data, '$.role') IN ('user','assistant'))`
    : '0'

  return `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
                 ${modelSelect} AS model_json, ${agentSelect} AS agent,
                 ${tokenSelects}, ${costSelect} AS cost,
                 ${messageCountSubquery} AS message_count
          FROM session s
          WHERE 1=1 ${parentIdPredicate} ${archivedPredicate}
          ORDER BY s.time_updated DESC
          LIMIT ?`
}

function rowToCandidate(row: SessionRow, dbPath: string): SessionFileCandidate {
  const mtimeMs =
    typeof row.time_updated === 'number' && row.time_updated > 0
      ? row.time_updated
      : row.time_created
  return {
    agent: 'opencode' as AiVaultAgent,
    file: {
      path: buildOpenCodeSqliteCandidatePath(dbPath, row.id),
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    },
    codexHome: null
  }
}

export async function listOpenCodeSqliteSessions(args: {
  dbPaths: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
}): Promise<SessionFileCandidate[]> {
  const candidates: SessionFileCandidate[] = []
  for (const dbPath of args.dbPaths) {
    let db: SyncDatabase | null = null
    try {
      db = openReadonlyDatabase(dbPath)
      if (!canReadOpenCodeSessions(db)) {
        continue
      }
      const rows = db.prepare(buildSessionListQuery(db)).all(args.limit) as SessionRow[]
      for (const row of rows) {
        candidates.push(rowToCandidate(row, dbPath))
      }
    } catch (err) {
      args.issues.push({
        agent: 'opencode',
        path: dbPath,
        message: errorMessage(err)
      })
    } finally {
      db?.close()
    }
  }
  return candidates
}

export async function discoverOpenCodeSessions(args: {
  storageDir: string
  dbPaths: readonly string[]
  limitPerAgent: number
  issues: AiVaultScanIssue[]
}): Promise<SessionFileDiscovery> {
  const [fileDiscovery, sqliteCandidates] = await Promise.all([
    discoverFiles({
      rootDir: join(args.storageDir, 'session'),
      limit: args.limitPerAgent,
      agent: 'opencode',
      issues: args.issues,
      extensions: ['.json']
    }),
    listOpenCodeSqliteSessions({
      dbPaths: args.dbPaths,
      limit: args.limitPerAgent,
      issues: args.issues
    })
  ])
  return {
    agent: 'opencode' as const,
    rootDir: fileDiscovery.rootDir,
    files: [...fileDiscovery.files, ...sqliteCandidates.map((c) => c.file)]
  }
}

export function dedupOpenCodeSessions(sessions: AiVaultSession[]): AiVaultSession[] {
  const opencodeSessions = sessions.filter((s) => s.agent === 'opencode')
  if (opencodeSessions.length === 0) {
    return sessions
  }
  const sqliteSessionIds = new Set<string>()
  for (const session of opencodeSessions) {
    if (splitOpenCodeSqliteCandidate(session.filePath)) {
      sqliteSessionIds.add(session.sessionId)
    }
  }
  if (sqliteSessionIds.size === 0) {
    return sessions
  }
  return sessions.filter((s) => {
    if (s.agent !== 'opencode') {
      return true
    }
    if (splitOpenCodeSqliteCandidate(s.filePath)) {
      return true
    }
    // Why: file-based entry whose sessionId also exists in SQLite — drop it.
    return !sqliteSessionIds.has(s.sessionId)
  })
}
