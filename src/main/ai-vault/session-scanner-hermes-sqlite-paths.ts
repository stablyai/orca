import { basename, win32 } from 'node:path'

export function buildHermesSqliteCandidatePath(dbPath: string, sessionId: string): string {
  return `${dbPath}#${encodeURIComponent(sessionId)}`
}

export function splitHermesSqliteCandidate(
  candidatePath: string
): { dbPath: string; sessionId: string } | null {
  const separator = candidatePath.lastIndexOf('#')
  if (separator <= 0 || separator === candidatePath.length - 1) {
    return null
  }
  const dbPath = candidatePath.slice(0, separator)
  const name = (dbPath.includes('\\') ? win32.basename(dbPath) : basename(dbPath)).toLowerCase()
  if (name !== 'state.db' && !/^hermes(?:-[a-z0-9_.-]+)?\.db$/i.test(name)) {
    return null
  }
  try {
    return { dbPath, sessionId: decodeURIComponent(candidatePath.slice(separator + 1)) }
  } catch {
    return null
  }
}
