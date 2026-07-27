const HERMES_SQLITE_PATH_SEPARATOR = '#'

export function buildHermesSqliteCandidatePath(dbPath: string, sessionId: string): string {
  return `${dbPath}${HERMES_SQLITE_PATH_SEPARATOR}${sessionId}`
}

function isHermesStateDbPath(dbPath: string): boolean {
  const fileName = dbPath.replaceAll(String.fromCharCode(92), '/').split('/').pop() ?? ''
  return fileName.toLowerCase() === 'state.db'
}

export function splitHermesSqliteCandidate(
  candidatePath: string
): { dbPath: string; sessionId: string } | null {
  const separatorIndex = candidatePath.lastIndexOf(HERMES_SQLITE_PATH_SEPARATOR)
  if (separatorIndex <= 0 || separatorIndex === candidatePath.length - 1) {
    return null
  }
  const dbPath = candidatePath.slice(0, separatorIndex)
  const sessionId = candidatePath.slice(separatorIndex + 1)
  if (!isHermesStateDbPath(dbPath) || !sessionId) {
    return null
  }
  return { dbPath, sessionId }
}
