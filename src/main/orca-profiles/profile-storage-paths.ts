import { app } from 'electron'
import { join } from 'node:path'

const LEGACY_DATA_FILE_NAME = 'orca-data.json'
const LEGACY_BROWSER_SESSION_META_FILE_NAME = 'browser-session-meta.json'
const PROFILE_INDEX_FILE_NAME = 'orca-profile-index.json'
const PROFILE_DATA_FILE_NAME = 'orca-data.json'
const PROFILE_BROWSER_SESSION_META_FILE_NAME = 'browser-session-meta.json'
const PROFILE_DIRECTORY_NAME = 'profiles'

export const LEGACY_BACKUP_COUNT = 5

let profileUserDataPath: string | null = null

export function initOrcaProfilePaths(): void {
  profileUserDataPath = app.getPath('userData')
}

export function getProfileUserDataPath(): string {
  if (!profileUserDataPath) {
    profileUserDataPath = app.getPath('userData')
  }
  return profileUserDataPath
}

export function getOrcaProfileIndexPath(userDataPath = getProfileUserDataPath()): string {
  return join(userDataPath, PROFILE_INDEX_FILE_NAME)
}

export function getOrcaProfilesDirectory(userDataPath = getProfileUserDataPath()): string {
  return join(userDataPath, PROFILE_DIRECTORY_NAME)
}

export function getOrcaProfileDirectory(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): string {
  return join(getOrcaProfilesDirectory(userDataPath), profileId)
}

export function getOrcaProfileDataFile(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), PROFILE_DATA_FILE_NAME)
}

export function getOrcaProfileBrowserSessionMetaFile(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): string {
  return join(
    getOrcaProfileDirectory(profileId, userDataPath),
    PROFILE_BROWSER_SESSION_META_FILE_NAME
  )
}

export function legacyDataFilePath(userDataPath: string): string {
  return join(userDataPath, LEGACY_DATA_FILE_NAME)
}

export function legacyBrowserSessionMetaPath(userDataPath: string): string {
  return join(userDataPath, LEGACY_BROWSER_SESSION_META_FILE_NAME)
}

export function legacyBackupPath(userDataPath: string, index: number): string {
  return `${legacyDataFilePath(userDataPath)}.bak.${index}`
}

export function profileBackupPath(profileDataFile: string, index: number): string {
  return `${profileDataFile}.bak.${index}`
}
