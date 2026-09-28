import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile
} from '../../../shared/profile-state-storage-paths'
import type { ProfileStateOfflineLocation } from './profile-state-offline-settings'
import { ProfileStateRecoveryCommandError } from '../../../shared/profile-state-recovery-command'

/** Resolve the active profile files for offline profile-state commands. */
export function getActiveProfileStateLocation(
  userDataPath: string
): ProfileStateOfflineLocation | undefined {
  const indexPath = join(userDataPath, 'orca-profile-index.json')
  const candidates = [indexPath, `${indexPath}.bak`].filter(existsSync)
  if (candidates.length === 0) {
    return undefined
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf-8'))
      if (!isRecord(parsed) || !Array.isArray(parsed.profiles)) {
        continue
      }
      const profileId = parsed.activeProfileId
      if (
        typeof profileId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(profileId) &&
        parsed.profiles.some((profile) => isRecord(profile) && profile.id === profileId)
      ) {
        return {
          dataFile: getOrcaProfileDataFile(profileId, userDataPath),
          databaseFile: getOrcaProfileStateDatabaseFile(profileId, userDataPath),
          profileId
        }
      }
    } catch {
      // Try the profile-index backup before failing closed.
    }
  }
  throw new ProfileStateRecoveryCommandError(
    'runtime_error',
    `Could not read active profile index ${indexPath}`
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
