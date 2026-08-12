import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  buildOpenCodeSqliteCandidatePath,
  splitOpenCodeSqliteCandidate
} from './session-scanner-opencode-sqlite-paths'
import type { SessionFileCandidate } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

// Why: opencode2 (beta) sessions live in a channel-scoped SQLite DB
// (opencode-next.db / opencode-local.db) with its own schema — `session_v2`
// rows plus `session_message` parts, no `part` table. Beta-unstable schema, so
// every read is column-guarded and drift fails soft to no sessions.
// Electron-free so the worker entry can import it.

const OPENCODE2_SESSION_TABLE = 'session_v2'

type SessionRow = {
  id: string
  time_created: number
  time_updated: number
}

function openReadonlyDatabase(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  return db
}

function canReadOpenCode2Sessions(db: SyncDatabase): boolean {
  return (
    tableExists(db, OPENCODE2_SESSION_TABLE) &&
    columnExists(db, OPENCODE2_SESSION_TABLE, 'time_created') &&
    columnExists(db, OPENCODE2_SESSION_TABLE, 'time_updated')
  )
}

function buildSessionListQuery(db: SyncDatabase, limited: boolean): string {
  // Why: v2 tracks parent/fork relations and archived sessions; only list
  // top-level, non-archived rows, mirroring the v1 list predicate.
  const parentIdPredicate = columnExists(db, OPENCODE2_SESSION_TABLE, 'parent_id')
    ? 'AND parent_id IS NULL'
    : ''
  const archivedPredicate = columnExists(db, OPENCODE2_SESSION_TABLE, 'time_archived')
    ? 'AND time_archived IS NULL'
    : ''

  return `SELECT id, time_created, time_updated
          FROM ${OPENCODE2_SESSION_TABLE}
          WHERE 1=1 ${parentIdPredicate} ${archivedPredicate}
          ORDER BY CASE WHEN time_updated > 0 THEN time_updated ELSE time_created END DESC
          ${limited ? 'LIMIT ?' : ''}`
}

function rowToCandidate(row: SessionRow, dbPath: string): SessionFileCandidate {
  const mtimeMs =
    typeof row.time_updated === 'number' && row.time_updated > 0
      ? row.time_updated
      : row.time_created
  return {
    agent: 'opencode2' as AiVaultAgent,
    file: {
      path: buildOpenCodeSqliteCandidatePath(dbPath, row.id),
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    },
    codexHome: null
  }
}

function dedupeAndSortCandidates(candidates: SessionFileCandidate[]): SessionFileCandidate[] {
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
 * List opencode2 sessions from one or more channel-scoped SQLite databases as
 * synthetic `SessionFileCandidate` entries, mirroring the v1 SQLite list leg.
 * Databases that lack the `session_v2` table are silently skipped; errors are
 * recorded as scan issues.
 */
export async function listOpenCode2SqliteSessions(args: {
  dbPaths: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
}): Promise<SessionFileCandidate[]> {
  const candidates: SessionFileCandidate[] = []
  for (const dbPath of args.dbPaths) {
    let db: SyncDatabase | null = null
    try {
      db = openReadonlyDatabase(dbPath)
      if (!canReadOpenCode2Sessions(db)) {
        continue
      }
      const limited = Number.isFinite(args.limit)
      const statement = db.prepare(buildSessionListQuery(db, limited))
      const rows = (limited ? statement.all(args.limit) : statement.all()) as SessionRow[]
      for (const row of rows) {
        candidates.push(rowToCandidate(row, dbPath))
      }
    } catch (err) {
      args.issues.push({
        agent: 'opencode2',
        path: dbPath,
        message: errorMessage(err)
      })
    } finally {
      db?.close()
    }
  }
  return dedupeAndSortCandidates(candidates)
}
