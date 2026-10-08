import { existsSync, readFileSync } from 'node:fs'
import { Store } from '../../loading-store/store'
import type { ProfileStateStartupPaneAlias } from '../../loading-store/profile-state-authority'
import { ProfileStateAuthorityBootstrapError } from '../profile-state-recovery-required'
import {
  PROFILE_STATE_LEGACY_BACKUP_COUNT,
  profileStateLegacyBackupPath
} from './profile-state-legacy-backup-path'

export function prepareLegacyProfileState(dataFile: string, rawJson: string) {
  try {
    return prepareLegacySnapshot(dataFile, rawJson)
  } catch (error) {
    // Import the first usable legacy backup without overwriting the damaged source.
    for (let index = 0; index < PROFILE_STATE_LEGACY_BACKUP_COUNT; index += 1) {
      const path = profileStateLegacyBackupPath(dataFile, index)
      if (!existsSync(path)) {
        continue
      }
      try {
        const prepared = prepareLegacySnapshot(dataFile, readFileSync(path, 'utf8'))
        console.warn(`[profile-state] Recovered legacy state from ${path}`)
        return prepared
      } catch {
        // A corrupt backup must not prevent trying the remaining legacy ring.
      }
    }
    throw new ProfileStateAuthorityBootstrapError(
      `Failed to load imported profile state or its legacy backups: ${dataFile}. ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function prepareLegacySnapshot(dataFile: string, serializedState: string) {
  const unboundPaneAliases: ProfileStateStartupPaneAlias[] = []
  const store = new Store({
    dataFile,
    serializedState,
    collectUnboundPaneAlias: (entry) => unboundPaneAliases.push(entry)
  })
  return { prepared: store.prepareProfileStateExport(), unboundPaneAliases }
}
