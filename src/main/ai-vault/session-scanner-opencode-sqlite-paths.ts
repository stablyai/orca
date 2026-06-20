import { basename } from 'path'

// Why: keep the synthetic candidate-path helpers separate from the SQLite
// discovery/parser so both the scanner and the agent-parser dispatcher can
// import them without pulling in the SyncDatabase dependency.

const OPENCODE_SQLITE_PATH_SEPARATOR = '#'

export function buildOpenCodeSqliteCandidatePath(dbPath: string, sessionId: string): string {
  return `${dbPath}${OPENCODE_SQLITE_PATH_SEPARATOR}${sessionId}`
}

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

export function looksLikeOpenCodeSqliteCandidate(candidatePath: string): boolean {
  return splitOpenCodeSqliteCandidate(candidatePath) !== null
}
