import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { profileStateJsonExportPaths } from '../persistence/profile-state/legacy-json/profile-state-export-path'
import { profileStateDatabaseBackups } from '../persistence/profile-state/profile-state-backup-path'
import { hasProfileStateDatabaseFiles } from '../persistence/profile-state/profile-state-storage-classification'

// Keep the pre-ready graph small; this stable ID mirrors DEFAULT_LOCAL_ORCA_PROFILE_ID.
const DEFAULT_LOCAL_PROFILE_ID = 'local-default'

/** `null` means malformed index; `undefined` means a pre-profile legacy install. */
export function readActiveProfileId(userDataPath: string): string | null | undefined {
  const indexPath = join(userDataPath, 'orca-profile-index.json')
  const candidates = [indexPath, `${indexPath}.bak`].filter(existsSync)
  if (candidates.length === 0) {
    return undefined
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf-8'))
      if (!isRecord(parsed) || typeof parsed.activeProfileId !== 'string') {
        continue
      }
      if (
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(parsed.activeProfileId) &&
        Array.isArray(parsed.profiles) &&
        parsed.profiles.some(
          (profile) => isRecord(profile) && profile.id === parsed.activeProfileId
        )
      ) {
        return parsed.activeProfileId
      }
    } catch {
      // A torn primary can still have a valid recovery index.
    }
  }
  return null
}

/** Read JSON only when no profile database is present; pre-ready cannot open SQLite safely. */
export function readPersistedHttp1CompatibilityMode(userDataPath: string): boolean {
  const activeProfileId = readActiveProfileId(userDataPath)
  if (activeProfileId === null) {
    // A malformed profile index leaves the active profile unknowable.
    return false
  }

  const profileDataFile =
    activeProfileId === undefined
      ? undefined
      : join(userDataPath, 'profiles', activeProfileId, 'orca-data.json')
  const profileDatabaseFile =
    activeProfileId === undefined
      ? undefined
      : join(userDataPath, 'profiles', activeProfileId, 'profile-state.db')
  // SQLite is authoritative once present; a missing marker therefore fails closed.
  if (profileDatabaseFile !== undefined && hasProfileStateDatabaseFiles(profileDatabaseFile)) {
    return false
  }

  if (
    activeProfileId !== undefined &&
    activeProfileId !== DEFAULT_LOCAL_PROFILE_ID &&
    (profileDataFile === undefined || !existsSync(profileDataFile))
  ) {
    // A known but unseeded non-default profile has default settings. The
    // install-level legacy file belongs to another profile and must not leak.
    return false
  }
  const dataFile = profileDataFile ?? join(userDataPath, 'orca-data.json')
  // A retained migration export proves SQLite was established. Do not let the
  // pre-ready path read a stale JSON mirror while recovery is required.
  try {
    if (
      profileStateJsonExportPaths(dataFile).length > 0 ||
      profileStateDatabaseBackups(
        profileDatabaseFile ?? join(dirname(dataFile), 'profile-state.db')
      ).length > 0
    ) {
      return false
    }
  } catch {
    return false
  }
  if (!existsSync(dataFile)) {
    return false
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(dataFile, 'utf-8'))
    if (!isRecord(parsed) || !isRecord(parsed.settings)) {
      return false
    }
    return parsed.settings.electronHttp1CompatibilityMode === true
  } catch {
    return false
  }
}

/** Return whether a retained SQLite export makes pre-ready JSON/marker state untrusted. */
export function hasMissingProfileStateDatabaseWithRetainedExport(
  userDataPath: string,
  profileId: string
): boolean {
  const profileDirectory = join(userDataPath, 'profiles', profileId)
  const databaseFile = join(profileDirectory, 'profile-state.db')
  if (hasProfileStateDatabaseFiles(databaseFile)) {
    return false
  }
  const dataFile = join(profileDirectory, 'orca-data.json')
  try {
    return (
      profileStateJsonExportPaths(dataFile).length > 0 ||
      profileStateDatabaseBackups(databaseFile).length > 0
    )
  } catch {
    return true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
