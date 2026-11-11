import { existsSync } from 'node:fs'

export const PROFILE_STATE_LEGACY_BACKUP_COUNT = 5

export function profileStateLegacyBackupPath(dataFile: string, index: number): string {
  return `${dataFile}.bak.${index}`
}

export function hasStateBackup(dataFile: string): boolean {
  for (let index = 0; index < PROFILE_STATE_LEGACY_BACKUP_COUNT; index += 1) {
    if (existsSync(profileStateLegacyBackupPath(dataFile, index))) {
      return true
    }
  }
  return false
}
