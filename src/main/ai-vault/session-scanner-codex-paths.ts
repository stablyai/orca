import { dirname, join, resolve } from 'node:path'

export const CODEX_LIVE_SESSIONS_DIR_NAME = 'sessions'
export const CODEX_ARCHIVED_SESSIONS_DIR_NAME = 'archived_sessions'

export function isCodexHistoryDirName(name: string): boolean {
  return name === CODEX_LIVE_SESSIONS_DIR_NAME || name === CODEX_ARCHIVED_SESSIONS_DIR_NAME
}

export function siblingCodexArchivedSessionsDir(sessionsDir: string): string {
  return join(dirname(sessionsDir), CODEX_ARCHIVED_SESSIONS_DIR_NAME)
}

export function codexHomeForSessionsDir(
  sessionsDir: string,
  defaultCodexHomeDir: string
): string | null {
  const codexHome = dirname(sessionsDir)
  return codexHome === defaultCodexHomeDir ? null : codexHome
}

export function uniqueCodexSessionsDirs(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const path of paths) {
    const trimmed = path.trim()
    if (!trimmed) {
      continue
    }
    const key = resolve(trimmed)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}
