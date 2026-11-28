import { lstatSync } from 'node:fs'
import { join } from 'node:path'

export function journalLegacyRecordPaths(stateDirectory: string): readonly [string, string] {
  const primary = join(stateDirectory, 'agent-sessions', 'agent-sessions.json')
  return [primary, `${primary}.bak`]
}

export function hasJournalLegacyRecordFile(stateDirectory: string): boolean {
  return journalLegacyRecordPaths(stateDirectory).some((path) => {
    try {
      lstatSync(path)
      return true
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      return code !== 'ENOENT' && code !== 'ENOTDIR'
    }
  })
}
