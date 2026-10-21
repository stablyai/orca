import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../shared/orca-profiles'
import { PROFILE_STATE_DATABASE_FILE_NAME } from '../../shared/profile-state-storage-paths'
import { getActiveProfileStateLocation } from '../persistence/profile-state/profile-state-active-location'
import { readProfileStateDomain } from '../persistence/profile-state/profile-state-domain-reader'
import { classifyProfileStateStorage } from '../persistence/profile-state/profile-state-storage-classification'

/**
 * Whether the profile `orca serve` would load has saved SSH targets. Read-only: never creates,
 * migrates or locks the profile, because the serve host that starts next owns it. Throws when it
 * cannot tell, including for an older schema the serve host would still migrate.
 */
export function serveProfileHasSshTargets(userDataPath: string): boolean {
  // A profile index predates any profile-state import, so no index means the legacy root files.
  const location = getActiveProfileStateLocation(userDataPath) ?? {
    dataFile: join(userDataPath, 'orca-data.json'),
    databaseFile: join(userDataPath, PROFILE_STATE_DATABASE_FILE_NAME),
    profileId: DEFAULT_LOCAL_ORCA_PROFILE_ID
  }
  const storage = classifyProfileStateStorage(location.dataFile, location.databaseFile)
  if (storage === 'neither') {
    return false
  }
  if (storage === 'json-only') {
    const parsed: unknown = JSON.parse(readFileSync(location.dataFile, 'utf8'))
    return hasEntries(isRecord(parsed) ? parsed.sshTargets : undefined)
  }
  const result = readProfileStateDomain(location.databaseFile, location.profileId, 'sshTargets')
  if (result.kind === 'unreadable') {
    throw result.error
  }
  return result.kind === 'value' && hasEntries(result.value)
}

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
