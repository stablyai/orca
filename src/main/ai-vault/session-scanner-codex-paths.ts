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
    const key = resolve(trimmed)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}
