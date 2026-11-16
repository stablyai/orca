import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import { getTomlTableHeader } from './config-toml-line-scan'

/** Duplicate tables or keys Codex's TOML parser would reject; fixtures hold no multiline values. */
export function findDuplicateTomlDeclarations(content: string): string[] {
  const duplicates: string[] = []
  const tables = new Set<string>()
  let table = '[]'
  let keys = new Set<string>()
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const header = getTomlTableHeader(line)
    if (header !== null) {
      table = JSON.stringify(parseTomlTableHeaderPath(header)?.segments ?? header)
      if (tables.has(table)) {
        duplicates.push(`table ${table}`)
      }
      tables.add(table)
      keys = new Set()
      continue
    }
    const key = parseTomlKeyPath(line)
    if (key && line[key.end] === '=') {
      const keyName = JSON.stringify(key.segments)
      if (keys.has(keyName)) {
        duplicates.push(`key ${keyName} in ${table}`)
      }
      keys.add(keyName)
    }
  }
  return duplicates
}
