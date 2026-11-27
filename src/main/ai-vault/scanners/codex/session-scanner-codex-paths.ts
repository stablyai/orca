import { dirname, join, resolve } from 'node:path'

export function codexHomeForSessionsDir(
  sessionsDir: string,
  defaultCodexHomeDir: string
): string | null {
  const codexHome = dirname(sessionsDir)
  return codexHome === defaultCodexHomeDir ? null : codexHome
}

/**
 * Codex moves a rollout idle 7+ days from `sessions` into a sibling flat `archived_sessions`
 * folder. Walk both, so History and search still list a chat the user archived in Codex.
 */
export function codexRootDirsForSessionsDir(sessionsDir: string): string[] {
  const trimmed = sessionsDir.trim()
  // An empty root resolves to cwd; never expand it into a walk of the working directory.
  if (!trimmed) {
    return []
  }
  return [trimmed, join(dirname(trimmed), 'archived_sessions')]
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
