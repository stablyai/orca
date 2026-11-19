import { inCredentialFileOrder } from '../credentials/credential-file-io'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { bestEffortFsyncDirectory } from '../../shared/secure-storage/secure-file-async-write'
import {
  DEFAULT_LOCAL_ORCA_PROFILE_ID,
  type OrcaProfileIndex
} from '../../shared/orca-profiles/orca-profiles'
import { hasProfileStateDatabaseFilesAsync } from '../persistence/profile-state/database/profile-state-storage-classification'
import { hasProfileStateAuthorityMarkerAsync } from '../persistence/profile-state/database/profile-state-authority-marker'
import { profileStateJsonExportPathsAsync } from '../persistence/profile-state/legacy-json/profile-state-export-path'
import { profileStateDatabaseBackupsAsync } from '../persistence/profile-state/backup/profile-state-backup-path'
import { copyLegacyStateToProfileAsync } from './storage/profile-legacy-state-import'
import {
  normalizeProfileIndex,
  createInitialProfileIndex,
  getActiveProfile
} from './profile-index-schema'
import {
  getOrcaProfileIndexPath,
  getOrcaProfileDirectory,
  getOrcaProfileStateDatabaseFile,
  getOrcaProfileDataFile,
  getProfileUserDataPath
} from './profile-storage-paths'
import type { ActiveOrcaProfileState } from './profile-index-store'

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

export async function writeProfileIndexAsync(
  indexPath: string,
  index: OrcaProfileIndex
): Promise<void> {
  await mkdir(dirname(indexPath), { recursive: true })
  // Never replace the recovery backup with a corrupt primary index.
  if ((await profileIndexPathExists(indexPath)) && (await readProfileIndexFileAsync(indexPath))) {
    try {
      await copyFile(indexPath, `${indexPath}.bak`)
    } catch {
      // Backup failure must not block the primary write.
    }
  }
  const tmpPath = `${indexPath}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmpPath, 'wx')
    try {
      await handle.writeFile(JSON.stringify(index, null, 2), 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmpPath, indexPath)
  } finally {
    await rm(tmpPath, { force: true })
  }
  await bestEffortFsyncDirectory(dirname(indexPath))
}

export async function loadOrCreateProfileIndexAsync(
  userDataPath: string
): Promise<OrcaProfileIndex> {
  const indexPath = getOrcaProfileIndexPath(userDataPath)
  const index = await readExistingProfileIndexAsync(indexPath)
  if (index) {
    return index
  }
  const nextIndex = createInitialProfileIndex()
  await writeProfileIndexAsync(indexPath, nextIndex)
  return nextIndex
}

export async function ensureActiveOrcaProfileAsync(
  userDataPath = getProfileUserDataPath()
): Promise<ActiveOrcaProfileState> {
  return inCredentialFileOrder(`${getOrcaProfileIndexPath(userDataPath)}.mutation`, async () => {
    const indexPath = getOrcaProfileIndexPath(userDataPath)
    let index = await readExistingProfileIndexAsync(indexPath)
    let shouldWriteIndex = !(await profileIndexPathExists(indexPath))

    if (!index) {
      index = createInitialProfileIndex()
      shouldWriteIndex = true
    }

    const activeProfile = getActiveProfile(index)
    if (activeProfile.id !== index.activeProfileId) {
      index = { ...index, activeProfileId: activeProfile.id }
      shouldWriteIndex = true
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

    if (shouldWriteIndex) {
      await writeProfileIndexAsync(indexPath, index)
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
