import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'

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
    // Why: an account home on the shared store links its `sessions` to the history home's; scan it once.
    const key = parseWslUncPath(trimmed) ? resolve(trimmed) : realOrResolved(trimmed)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
