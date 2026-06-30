import { basename, extname, join } from 'node:path'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'
import { buildOpenCodeSqliteCandidatePath } from './session-scanner-opencode-sqlite-paths'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import type {
  FileWithMtime,
  SessionFileCandidate,
  SessionFileDiscovery
} from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

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

function sessionColumnSelect(db: SyncDatabase, columnName: string): string {
  return columnExists(db, 'session', columnName) ? `s.${columnName}` : 'NULL'
}

function canCountOpenCodeMessages(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'message') &&
    columnExists(db, 'message', 'session_id') &&
    columnExists(db, 'message', 'data')
  )
}

function buildSessionListQuery(db: SyncDatabase): string {
  const modelSelect = sessionColumnSelect(db, 'model')
  const agentSelect = sessionColumnSelect(db, 'agent')
  const tokenColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read']
  const tokenSelects = tokenColumns
    .map((col) => `${columnExists(db, 'session', col) ? `s.${col}` : '0'} AS ${col}`)
    .join(', ')
  const costSelect = columnExists(db, 'session', 'cost') ? 's.cost' : '0'
  const parentIdPredicate = columnExists(db, 'session', 'parent_id')
    ? 'AND s.parent_id IS NULL'
    : ''
  const archivedPredicate = columnExists(db, 'session', 'time_archived')
    ? 'AND s.time_archived IS NULL'
    : ''
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

function dedupeAndSortSqliteCandidates(candidates: SessionFileCandidate[]): SessionFileCandidate[] {
  const candidatesBySessionId = new Map<string, SessionFileCandidate>()
  for (const candidate of candidates) {
    const parsed = splitOpenCodeSqliteCandidate(candidate.file.path)
    if (!parsed) {
      continue
    }
    const previous = candidatesBySessionId.get(parsed.sessionId)
    if (!previous || candidate.file.mtimeMs > previous.file.mtimeMs) {
      candidatesBySessionId.set(parsed.sessionId, candidate)
    }
  }
  return [...candidatesBySessionId.values()].sort((left, right) => {
    return right.file.mtimeMs - left.file.mtimeMs
  })
}

/**
 * List OpenCode sessions from one or more SQLite databases as synthetic
 * `SessionFileCandidate` entries. Each candidate's file path is a synthetic
 * `<dbPath>#<sessionId>` string that the parser dispatcher routes to
 * `parseOpenCodeSqliteSession`. Databases that lack the `session` table are
 * silently skipped; errors are recorded as scan issues.
 * @param args.dbPaths - Absolute paths to opencode.db files to scan.
 * @param args.limit - Maximum number of sessions to return per database.
 * @param args.issues - Collected scan issues to append errors to.
 * @returns Array of synthetic candidates sorted by `time_updated` DESC.
 */
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
  return dedupeAndSortSqliteCandidates(candidates)
}

// Why: extract the sessionId from a legacy file path like
// storage/session/<projectId>/<sessionId>.json. Falls back to the filename
// without extension when the opencode id format doesn't match a UUID.
function sessionIdFromLegacyFilePath(filePath: string): string {
  return basename(filePath, extname(filePath))
}

/**
 * Discover OpenCode sessions from both the legacy file layout and the SQLite
 * DB, deduplicating at the file level before parsing. On mixed installs the
 * same session may appear once via a stale legacy JSON file and once via the
 * SQLite DB; SQLite is the source of truth on 1.17.x, so file-based entries
 * whose sessionId matches a SQLite entry are dropped. Legacy installs without
 * the `session` table fall through to the file scanner unchanged.
 * @param args.storageDir - Root of the OpenCode storage directory (contains `session/` and `message/`).
 * @param args.dbPaths - Absolute paths to opencode.db files to scan.
 * @param args.limitPerAgent - Maximum number of candidates per source.
 * @param args.issues - Collected scan issues to append errors to.
 * @returns A `SessionFileDiscovery` with deduplicated file entries.
 */
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

  const sqliteFiles = sqliteCandidates.map((c) => c.file)
  // Why: on mixed installs the same OpenCode session may appear once via the
  // SQLite DB and once via a stale legacy JSON file. SQLite is the source of
  // truth on 1.17.x, so drop file-based duplicates when a SQLite entry with
  // the same sessionId already exists. Deduping at the file level also avoids
  // parsing the same session twice.
  if (sqliteFiles.length === 0) {
    return {
      agent: 'opencode' as const,
      rootDir: fileDiscovery.rootDir,
      files: fileDiscovery.files
    }
  }
  const sqliteSessionIds = new Set<string>()
  for (const file of sqliteFiles) {
    const parsed = splitOpenCodeSqliteCandidate(file.path)
    if (parsed) {
      sqliteSessionIds.add(parsed.sessionId)
    }
  }
  const dedupedFileDiscovery: FileWithMtime[] = []
  for (const file of fileDiscovery.files) {
    if (!sqliteSessionIds.has(sessionIdFromLegacyFilePath(file.path))) {
      dedupedFileDiscovery.push(file)
    }
  }

  return {
    agent: 'opencode' as const,
    rootDir: fileDiscovery.rootDir,
    files: [...dedupedFileDiscovery, ...sqliteFiles]
  }
}
