import { basename } from 'node:path'

// Why: `#` isolates the SQLite DB path from the session ID in synthetic candidates.
const HERMES_SQLITE_PATH_SEPARATOR = '#'

/**
 * Build a synthetic candidate path that encodes the SQLite DB path and session ID
 * as `<dbPath>#<sessionId>`. Used by the discovery layer so SQLite-backed
 * sessions flow through the same FileWithMtime pipeline as file-backed ones.
 * @param dbPath - Absolute path to the state.db file.
 * @param sessionId - The Hermes session ID (primary key in the sessions table).
 * @returns The synthetic candidate path string.
 */
export function buildHermesSqliteCandidatePath(dbPath: string, sessionId: string): string {
  return `${dbPath}${HERMES_SQLITE_PATH_SEPARATOR}${sessionId}`
}

/**
 * Parse a synthetic candidate path back into its DB path and session ID parts.
 * Validates that the DB basename matches `state.db` or `hermes*.db` so real
 * filesystem paths that happen to contain `#` are never misrouted to the SQLite parser.
 * @param candidatePath - The synthetic path to parse.
 * @returns `{ dbPath, sessionId }` if the path is a valid synthetic candidate, `null` otherwise.
 */
export function splitHermesSqliteCandidate(
  candidatePath: string
): { dbPath: string; sessionId: string } | null {
  const separatorIndex = candidatePath.lastIndexOf(HERMES_SQLITE_PATH_SEPARATOR)
  if (separatorIndex <= 0 || separatorIndex === candidatePath.length - 1) {
    return null
  }
  const dbPath = candidatePath.slice(0, separatorIndex)
  const sessionId = candidatePath.slice(separatorIndex + 1)
  if (!dbPath || !sessionId) {
    return null
  }
  const name = basename(dbPath).toLowerCase()
  // Why: Hermes 0.19+ stores SQLite session databases as state.db or hermes*.db.
  if (name !== 'state.db' && !/^hermes(?:-[A-Za-z0-9_.-]+)?\.db$/i.test(name)) {
    return null
  }
  return { dbPath, sessionId }
}

/**
 * Type guard: returns `true` if the path is a valid synthetic Hermes SQLite
 * candidate path (i.e. `splitHermesSqliteCandidate` would return non-null).
 * @param candidatePath - The path to test.
 * @returns `true` if the path is a synthetic SQLite candidate, `false` otherwise.
 */
export function looksLikeHermesSqliteCandidate(candidatePath: string): boolean {
  return splitHermesSqliteCandidate(candidatePath) !== null
}
