import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

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
    let key = resolve(trimmed)
    try {
      key = realpathSync(trimmed)
    } catch {
      /* Missing roots remain discoverable on a later scan. */
    }
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}
