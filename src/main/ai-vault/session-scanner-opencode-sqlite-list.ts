import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  buildOpenCodeSqliteCandidatePath,
  splitOpenCodeSqliteCandidate
} from './session-scanner-opencode-sqlite-paths'
import {
  openCodeDatabaseScanIssue,
  readOpenCodeDatabase
} from './session-scanner-opencode-sqlite-open'
import type { SessionFileCandidate } from './session-scanner-types'
import type SyncDatabase from '../sqlite/sync-database'
import { selectedSqliteSessionId } from './session-scanner-selection'
import { scopedSessionRows } from './session-scanner-sqlite-scope-rows'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

type SessionRow = {
  id: string
  time_created: number
  time_updated: number
  directory?: unknown
}

function canReadOpenCodeSessions(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'session') &&
    columnExists(db, 'session', 'time_created') &&
    columnExists(db, 'session', 'time_updated')
  )
}

function buildSessionListQuery(
  db: SyncDatabase,
  limited: boolean,
  scoped: boolean,
  selected = false
): string {
  const parentIdPredicate = columnExists(db, 'session', 'parent_id') ? 'AND parent_id IS NULL' : ''
  const archivedPredicate = columnExists(db, 'session', 'time_archived')
    ? 'AND time_archived IS NULL'
    : ''

  // Discovery needs identity and recency; defer message blobs and unused metadata until parsing.
  const directory = scoped && columnExists(db, 'session', 'directory') ? ', directory' : ''
  return `SELECT id, time_created, time_updated${directory}
          FROM session
          WHERE 1=1 ${parentIdPredicate} ${archivedPredicate} ${selected ? 'AND id = ?' : ''}
          ORDER BY CASE WHEN time_updated > 0 THEN time_updated ELSE time_created END DESC
          ${limited ? 'LIMIT ?' : ''}`
}

function readSessionRows(
  db: SyncDatabase,
  limit: number,
  scopePaths: readonly string[] | undefined,
  dbPath: string
): SessionRow[] {
  if (!canReadOpenCodeSessions(db)) {
    return []
  }
  const scoped = scopePaths !== undefined && scopePaths.length > 0
  const limited = Number.isFinite(limit) && !scoped
  const statement = db.prepare(buildSessionListQuery(db, limited, scoped))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query above selects exactly these columns.
  const rows = (
    limited ? statement.all(limit) : scoped ? statement.iterate() : statement.all()
  ) as Iterable<SessionRow>
  return scoped && scopePaths
    ? scopedSessionRows(rows, scopePaths, limit, dbPath)
    : Array.from(rows)
}

function rowToCandidate(
  row: SessionRow,
  dbPath: string,
  agent: 'opencode' | 'zcode'
): SessionFileCandidate {
  const mtimeMs =
    typeof row.time_updated === 'number' && row.time_updated > 0
      ? row.time_updated
      : row.time_created
  return {
    agent,
    file: {
      path: buildOpenCodeSqliteCandidatePath(dbPath, row.id),
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    },
    codexHome: null
  }
}

function dedupeAndSortSqliteCandidates(
  candidates: SessionFileCandidate[],
  agent: 'opencode' | 'zcode'
): SessionFileCandidate[] {
  const candidatesBySessionId = new Map<string, SessionFileCandidate>()
  for (const candidate of candidates) {
    const parsed = splitOpenCodeSqliteCandidate(candidate.file.path, agent)
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

/** List synthetic db#session candidates; skip absent session schemas and report database failures as scan issues. */
export async function listOpenCodeSqliteSessions(args: {
  dbPaths: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
  agent?: 'opencode' | 'zcode'
  selectedSessionId?: string
  /** Lists only sessions whose directory is in scope, newest `limit` of them. */
  scopePaths?: readonly string[]
}): Promise<SessionFileCandidate[]> {
  const candidates: SessionFileCandidate[] = []
  const agent = args.agent ?? 'opencode'
  for (const dbPath of args.dbPaths) {
    try {
      const rows = readOpenCodeDatabase({
        dbPath,
        read: (db) => {
          const rows = readSessionRows(db, args.limit, args.scopePaths, dbPath)
          const selected = selectedSqliteSessionId(args.selectedSessionId, agent, dbPath)
          if (selected && canReadOpenCodeSessions(db) && !rows.some((row) => row.id === selected)) {
            const row = db.prepare(buildSessionListQuery(db, false, false, true)).get(selected)
            if (
              row &&
              typeof row.id === 'string' &&
              typeof row.time_created === 'number' &&
              typeof row.time_updated === 'number'
            ) {
              rows.push({
                id: row.id,
                time_created: row.time_created,
                time_updated: row.time_updated
              })
            }
          }
          return rows
        }
      })
      for (const row of rows) {
        candidates.push(rowToCandidate(row, dbPath, agent))
      }
    } catch (err) {
      args.issues.push(openCodeDatabaseScanIssue(dbPath, err, agent))
    }
  }
  return dedupeAndSortSqliteCandidates(candidates, agent)
}
