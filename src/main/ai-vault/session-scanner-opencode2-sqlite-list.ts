import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  buildOpenCodeSqliteCandidatePath,
  splitOpenCodeSqliteCandidate
} from './session-scanner-opencode-sqlite-paths'
import type { SessionFileCandidate } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import { selectedSqliteSessionId } from './session-scanner-selection'
import { scopedSessionRows } from './session-scanner-sqlite-scope-rows'

// V2 uses session_v2/session_message tables; guard evolving schemas in shared and channel databases.

const OPENCODE2_SESSION_TABLE = 'session_v2'

type SessionRow = {
  id: string
  time_created: number
  time_updated: number
  directory?: unknown
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

function buildSessionListQuery(
  db: SyncDatabase,
  limited: boolean,
  scoped: boolean,
  selected = false
): string {
  const parentIdPredicate = columnExists(db, OPENCODE2_SESSION_TABLE, 'parent_id')
    ? 'AND parent_id IS NULL'
    : ''
  const archivedPredicate = columnExists(db, OPENCODE2_SESSION_TABLE, 'time_archived')
    ? 'AND time_archived IS NULL'
    : ''

  const directory =
    scoped && columnExists(db, OPENCODE2_SESSION_TABLE, 'directory') ? ', directory' : ''
  return `SELECT id, time_created, time_updated${directory}
          FROM ${OPENCODE2_SESSION_TABLE}
          WHERE 1=1 ${parentIdPredicate} ${archivedPredicate} ${selected ? 'AND id = ?' : ''}
          ORDER BY CASE WHEN time_updated > 0 THEN time_updated ELSE time_created END DESC
          ${limited ? 'LIMIT ?' : ''}`
}

function rowToCandidate(row: SessionRow, dbPath: string): SessionFileCandidate {
  const mtimeMs =
    typeof row.time_updated === 'number' && row.time_updated > 0
      ? row.time_updated
      : row.time_created
  return {
    agent: 'opencode2',
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

/** Skip databases without readable v2 session tables; report query failures as scan issues. */
export async function listOpenCode2SqliteSessions(args: {
  dbPaths: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
  selectedSessionId?: string
  /** Lists only sessions whose directory is in scope, newest `limit` of them. */
  scopePaths?: readonly string[]
}): Promise<SessionFileCandidate[]> {
  const candidates: SessionFileCandidate[] = []
  const scoped = args.scopePaths !== undefined && args.scopePaths.length > 0
  for (const dbPath of args.dbPaths) {
    let db: SyncDatabase | null = null
    try {
      db = openReadonlyDatabase(dbPath)
      if (!canReadOpenCode2Sessions(db)) {
        continue
      }
      const limited = Number.isFinite(args.limit) && !scoped
      const statement = db.prepare(buildSessionListQuery(db, limited, scoped))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query above selects exactly these metadata columns.
      const listed = (
        limited ? statement.all(args.limit) : scoped ? statement.iterate() : statement.all()
      ) as Iterable<SessionRow>
      const rows =
        scoped && args.scopePaths
          ? scopedSessionRows(listed, args.scopePaths, args.limit, dbPath)
          : listed
      const selected = selectedSqliteSessionId(args.selectedSessionId, 'opencode2', dbPath)
      const selectedRow = selected
        ? db.prepare(buildSessionListQuery(db, false, false, true)).get(selected)
        : undefined
      if (
        selectedRow &&
        typeof selectedRow.id === 'string' &&
        typeof selectedRow.time_created === 'number' &&
        typeof selectedRow.time_updated === 'number'
      ) {
        candidates.push(
          rowToCandidate(
            {
              id: selectedRow.id,
              time_created: selectedRow.time_created,
              time_updated: selectedRow.time_updated
            },
            dbPath
          )
        )
      }
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
