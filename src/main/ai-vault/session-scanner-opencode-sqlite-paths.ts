import { basename } from 'node:path'

// Why: keep the synthetic candidate-path helpers separate from the SQLite
// discovery/parser so both the scanner and the agent-parser dispatcher can
// import them without pulling in the SyncDatabase dependency.

const OPENCODE_SQLITE_PATH_SEPARATOR = '#'

/**
 * Build a synthetic candidate path that encodes the SQLite DB path and session ID
 * as `<dbPath>#<sessionId>`. Used by the discovery layer so SQLite-backed
 * sessions flow through the same FileWithMtime pipeline as file-backed ones.
 * @param dbPath - Absolute path to the opencode.db file.
 * @param sessionId - The OpenCode session ID (primary key in the session table).
 * @returns The synthetic candidate path string.
 */
export function buildOpenCodeSqliteCandidatePath(dbPath: string, sessionId: string): string {
  return `${dbPath}${OPENCODE_SQLITE_PATH_SEPARATOR}${sessionId}`
}

/**
 * Parse a synthetic candidate path back into its DB path and session ID parts.
 * Validates that the DB basename matches `opencode*.db` so real filesystem paths
 * that happen to contain `#` are never misrouted to the SQLite parser.
 * @param candidatePath - The synthetic path to parse.
 * @returns `{ dbPath, sessionId }` if the path is a valid synthetic candidate, `null` otherwise.
 */
export function splitOpenCodeSqliteCandidate(
  candidatePath: string
): { dbPath: string; sessionId: string } | null {
  const separatorIndex = candidatePath.lastIndexOf(OPENCODE_SQLITE_PATH_SEPARATOR)
  if (separatorIndex <= 0 || separatorIndex === candidatePath.length - 1) {
    return null
  }
  const dbPath = candidatePath.slice(0, separatorIndex)
  const sessionId = candidatePath.slice(separatorIndex + 1)
  if (!dbPath || !sessionId) {
    return null
  }
  // Why: OpenCode DB files are named opencode*.db; reject anything else so we
  // never misroute a real filesystem path that happens to contain '#'.
  if (!/^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/i.test(basename(dbPath))) {
    return null
  }
  return { dbPath, sessionId }
}

/**
 * Type guard: returns `true` if the path is a valid synthetic OpenCode SQLite
 * candidate path (i.e. `splitOpenCodeSqliteCandidate` would return non-null).
 * @param candidatePath - The path to test.
 * @returns `true` if the path is a synthetic SQLite candidate, `false` otherwise.
 */
export function looksLikeOpenCodeSqliteCandidate(candidatePath: string): boolean {
  return splitOpenCodeSqliteCandidate(candidatePath) !== null
}
