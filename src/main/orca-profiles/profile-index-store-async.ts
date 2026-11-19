import { inCredentialFileOrder } from '../credentials/credential-file-io'
import { mkdir, readFile, stat } from 'node:fs/promises'
import {
  DEFAULT_LOCAL_ORCA_PROFILE_ID,
  type OrcaProfileIndex
} from '../../shared/orca-profiles/orca-profiles'
import { hasProfileStateDatabaseFilesAsync } from '../persistence/profile-state/database/profile-state-storage-classification'
import { hasProfileStateAuthorityMarkerAsync } from '../persistence/profile-state/database/profile-state-authority-marker'
import { profileStateJsonExportPathsAsync } from '../persistence/profile-state/legacy-json/profile-state-export-path'
import { profileStateDatabaseBackupsAsync } from '../persistence/profile-state/backup/profile-state-backup-path'
import { copyLegacyStateToProfileAsync } from './storage/profile-legacy-state-import'
import { normalizeProfileIndex, getActiveProfile } from './profile-index-schema'
import {
  getOrcaProfileIndexPath,
  getOrcaProfileDirectory,
  getOrcaProfileStateDatabaseFile,
  getOrcaProfileDataFile,
  getProfileUserDataPath
} from './profile-storage-paths'
import {
  ensureActiveOrcaProfile,
  loadOrCreateProfileIndex,
  type ActiveOrcaProfileState
} from './profile-index-store'

async function profileIndexPathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readProfileIndexFileAsync(indexPath: string): Promise<OrcaProfileIndex | null> {
  try {
    return normalizeProfileIndex(JSON.parse(await readFile(indexPath, 'utf-8')))
  } catch {
    return null
  }
}

export async function readProfileIndexAsync(indexPath: string): Promise<OrcaProfileIndex | null> {
  // Recover from backup rather than orphan other profiles by resetting a corrupt index.
  return (
    (await readProfileIndexFileAsync(indexPath)) ??
    (await readProfileIndexFileAsync(`${indexPath}.bak`))
  )
}

async function readExistingProfileIndexAsync(indexPath: string): Promise<OrcaProfileIndex | null> {
  const index = await readProfileIndexAsync(indexPath)
  if (
    !index &&
    ((await profileIndexPathExists(indexPath)) ||
      (await profileIndexPathExists(`${indexPath}.bak`)))
  ) {
    throw new Error(`Could not read active profile index ${indexPath}`)
  }
  return index
}

export async function loadOrCreateProfileIndexAsync(
  userDataPath: string
): Promise<OrcaProfileIndex> {
  const indexPath = getOrcaProfileIndexPath(userDataPath)
  const index = await readExistingProfileIndexAsync(indexPath)
  if (index) {
    return index
  }
  return loadOrCreateProfileIndex(userDataPath)
}

export async function ensureActiveOrcaProfileAsync(
  userDataPath = getProfileUserDataPath()
): Promise<ActiveOrcaProfileState> {
  return inCredentialFileOrder(`${getOrcaProfileIndexPath(userDataPath)}.mutation`, async () => {
    const indexPath = getOrcaProfileIndexPath(userDataPath)
    const index = await readExistingProfileIndexAsync(indexPath)
    if (!index || !(await profileIndexPathExists(indexPath))) {
      return ensureActiveOrcaProfile(userDataPath)
    }
    const activeProfile = getActiveProfile(index)
    if (activeProfile.id !== index.activeProfileId) {
      return ensureActiveOrcaProfile(userDataPath)
    }

    const profileDirectory = getOrcaProfileDirectory(activeProfile.id, userDataPath)
    await mkdir(profileDirectory, { recursive: true })
    const profileDatabaseFile = getOrcaProfileStateDatabaseFile(activeProfile.id, userDataPath)
    const profileDataFile = getOrcaProfileDataFile(activeProfile.id, userDataPath)
    let hasRetainedProfileStateAuthority = false
    try {
      hasRetainedProfileStateAuthority =
        (await hasProfileStateAuthorityMarkerAsync(profileDatabaseFile)) ||
        (await profileStateJsonExportPathsAsync(profileDataFile)).length > 0 ||
        (await profileStateDatabaseBackupsAsync(profileDatabaseFile)).length > 0
    } catch {
      // An unreadable profile directory must never trigger a fallback copy of legacy state.
      hasRetainedProfileStateAuthority = true
    }
    if (
      activeProfile.id === DEFAULT_LOCAL_ORCA_PROFILE_ID &&
      !(await hasProfileStateDatabaseFilesAsync(profileDatabaseFile)) &&
      !hasRetainedProfileStateAuthority
    ) {
      await copyLegacyStateToProfileAsync(userDataPath, activeProfile.id)
    }

    return {
      index,
      profile: activeProfile,
      dataFile: profileDataFile,
      stateDatabaseFile: profileDatabaseFile,
      profileDirectory
    }
  })
}
