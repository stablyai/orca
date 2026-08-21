import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { bestEffortFsyncDirectorySync, fsyncFileSync } from '../../shared/secure-file'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  createDefaultLocalMCodeProfile,
  DEFAULT_LOCAL_MCODE_PROFILE_ID,
  DEFAULT_LOCAL_MCODE_PROFILE_NAME,
  MCODE_PROFILE_INDEX_SCHEMA_VERSION,
  type CreateLocalMCodeProfileArgs,
  type CreateLocalMCodeProfileResult,
  type MCodeProfileIndex,
  type MCodeProfileListState,
  type MCodeProfileSummary
} from '../../shared/mcode-profiles'
import {
  getMCodeProfileBrowserSessionMetaFile,
  getMCodeProfileDataFile,
  getMCodeProfileDirectory,
  getMCodeProfileIndexPath,
  getProfileUserDataPath,
  LEGACY_BACKUP_COUNT,
  legacyBackupPath,
  legacyBrowserSessionMetaPath,
  legacyDataFilePath,
  profileBackupPath
} from './profile-storage-paths'

export {
  getMCodeProfileBrowserSessionMetaFile,
  getMCodeProfileDataFile,
  getMCodeProfileDirectory,
  getMCodeProfileIndexPath,
  getMCodeProfilesDirectory,
  initMCodeProfilePaths
} from './profile-storage-paths'

export type ActiveMCodeProfileState = {
  index: MCodeProfileIndex
  profile: MCodeProfileSummary
  dataFile: string
  profileDirectory: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProfileSummary(value: unknown): value is MCodeProfileSummary {
  if (!isObject(value)) {
    return false
  }
  const avatar = value.avatar
  const cloud = value.cloud
  return (
    typeof value.id === 'string' &&
    // Why: IDs from the on-disk index become filesystem path segments; a
    // tampered index must not be able to escape the profiles directory.
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.id) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    (value.kind === 'local' || value.kind === 'cloud-linked') &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.lastOpenedAt === 'number' &&
    isObject(avatar) &&
    avatar.kind === 'initials' &&
    typeof avatar.initials === 'string' &&
    avatar.color === 'neutral' &&
    (cloud === undefined || isObject(cloud))
  )
}

function normalizeProfileIndex(raw: unknown): MCodeProfileIndex | null {
  if (!isObject(raw) || !Array.isArray(raw.profiles)) {
    return null
  }
  const profiles = raw.profiles.filter(isProfileSummary)
  const activeProfileId =
    typeof raw.activeProfileId === 'string' &&
    profiles.some((profile) => profile.id === raw.activeProfileId)
      ? raw.activeProfileId
      : profiles[0]?.id
  if (!activeProfileId) {
    return null
  }
  return {
    schemaVersion: MCODE_PROFILE_INDEX_SCHEMA_VERSION,
    activeProfileId,
    profiles
  }
}

function sanitizeProfileName(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed.slice(0, 80) : 'New Profile'
}

function readProfileIndexFile(indexPath: string): MCodeProfileIndex | null {
  try {
    return normalizeProfileIndex(JSON.parse(readFileSync(indexPath, 'utf-8')))
  } catch {
    return null
  }
}

export function readProfileIndex(indexPath: string): MCodeProfileIndex | null {
  // Why: a torn/corrupt index must not silently reset the app to a single
  // default profile — that would orphan every other profile's data directory.
  return readProfileIndexFile(indexPath) ?? readProfileIndexFile(`${indexPath}.bak`)
}

export function writeProfileIndex(indexPath: string, index: MCodeProfileIndex): void {
  mkdirSync(dirname(indexPath), { recursive: true })
  // Why: only a still-parseable current index may refresh the backup;
  // copying a corrupt file over the backup would destroy the recovery copy.
  if (existsSync(indexPath) && readProfileIndexFile(indexPath)) {
    try {
      copyFileSync(indexPath, `${indexPath}.bak`)
    } catch {
      // Best-effort backup; the primary write below still proceeds.
    }
  }
  const tmpPath = `${indexPath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf-8')
  fsyncFileSync(tmpPath)
  renameSync(tmpPath, indexPath)
  bestEffortFsyncDirectorySync(dirname(indexPath))
}

function copyIfPresent(source: string, target: string): void {
  if (!existsSync(source) || existsSync(target)) {
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  // Why: tmp+rename so a crash mid-copy cannot leave a truncated target that
  // the exists() guard above would then treat as a completed migration.
  const tmpTarget = `${target}.tmp`
  copyFileSync(source, tmpTarget)
  renameSync(tmpTarget, target)
}

function copyLegacyStateToProfile(userDataPath: string, profileId: string): void {
  const profileDataFile = getMCodeProfileDataFile(profileId, userDataPath)
  copyIfPresent(legacyDataFilePath(userDataPath), profileDataFile)
  copyIfPresent(
    legacyBrowserSessionMetaPath(userDataPath),
    getMCodeProfileBrowserSessionMetaFile(profileId, userDataPath)
  )
  for (let i = 0; i < LEGACY_BACKUP_COUNT; i++) {
    copyIfPresent(legacyBackupPath(userDataPath, i), profileBackupPath(profileDataFile, i))
  }
}

// Why: a brand-new profile has no data file, which the telemetry cohort
// migration reads as a fresh install and defaults to opted-in. Copying the
// active profile's consent block keeps an opted-out user opted out (and keeps
// one installId per install) when they create additional profiles.
export function seedNewMCodeProfileTelemetryConsent(
  profileId: string,
  telemetry: GlobalSettings['telemetry'],
  userDataPath = getProfileUserDataPath()
): void {
  if (!telemetry) {
    return
  }
  const dataFile = getMCodeProfileDataFile(profileId, userDataPath)
  if (existsSync(dataFile)) {
    return
  }
  mkdirSync(dirname(dataFile), { recursive: true })
  const tmpPath = `${dataFile}.tmp`
  writeFileSync(tmpPath, JSON.stringify({ settings: { telemetry } }, null, 2), 'utf-8')
  renameSync(tmpPath, dataFile)
}

function createInitialProfileIndex(now = Date.now()): MCodeProfileIndex {
  const profile = createDefaultLocalMCodeProfile(now)
  return {
    schemaVersion: MCODE_PROFILE_INDEX_SCHEMA_VERSION,
    activeProfileId: profile.id,
    profiles: [profile]
  }
}

export function loadOrCreateProfileIndex(userDataPath: string): MCodeProfileIndex {
  const indexPath = getMCodeProfileIndexPath(userDataPath)
  const index = existsSync(indexPath) ? readProfileIndex(indexPath) : null
  if (index) {
    return index
  }
  const nextIndex = createInitialProfileIndex()
  writeProfileIndex(indexPath, nextIndex)
  return nextIndex
}

function getActiveProfile(index: MCodeProfileIndex): MCodeProfileSummary {
  return (
    index.profiles.find((profile) => profile.id === index.activeProfileId) ??
    index.profiles[0] ??
    createDefaultLocalMCodeProfile(Date.now())
  )
}

export function ensureActiveMCodeProfile(
  userDataPath = getProfileUserDataPath()
): ActiveMCodeProfileState {
  const indexPath = getMCodeProfileIndexPath(userDataPath)
  let index = existsSync(indexPath) ? readProfileIndex(indexPath) : null
  let shouldWriteIndex = false

  if (!index) {
    index = createInitialProfileIndex()
    shouldWriteIndex = true
  }

  const activeProfile = getActiveProfile(index)
  if (activeProfile.id !== index.activeProfileId) {
    index = { ...index, activeProfileId: activeProfile.id }
    shouldWriteIndex = true
  }

  const profileDirectory = getMCodeProfileDirectory(activeProfile.id, userDataPath)
  mkdirSync(profileDirectory, { recursive: true })
  if (activeProfile.id === DEFAULT_LOCAL_MCODE_PROFILE_ID) {
    copyLegacyStateToProfile(userDataPath, activeProfile.id)
  }

  if (shouldWriteIndex) {
    writeProfileIndex(indexPath, index)
  }

  return {
    index,
    profile: activeProfile,
    dataFile: getMCodeProfileDataFile(activeProfile.id, userDataPath),
    profileDirectory
  }
}

export function isDefaultLocalMCodeProfileId(profileId: string): boolean {
  return profileId === DEFAULT_LOCAL_MCODE_PROFILE_ID
}

export function getMCodeProfileListState(
  userDataPath = getProfileUserDataPath()
): MCodeProfileListState {
  const { index } = ensureActiveMCodeProfile(userDataPath)
  return {
    activeProfileId: index.activeProfileId,
    profiles: index.profiles
  }
}

export function createLocalMCodeProfile(
  args: CreateLocalMCodeProfileArgs = {},
  userDataPath = getProfileUserDataPath()
): CreateLocalMCodeProfileResult {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  const name = sanitizeProfileName(args.name)
  const profile: MCodeProfileSummary = {
    id: `local-${randomUUID()}`,
    name,
    avatar: {
      kind: 'initials',
      initials: (
        name.match(/[A-Za-z0-9]/)?.[0] ?? DEFAULT_LOCAL_MCODE_PROFILE_NAME[0]
      ).toUpperCase(),
      color: 'neutral'
    },
    kind: 'local',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now
  }
  const nextIndex: MCodeProfileIndex = {
    ...index,
    profiles: [...index.profiles, profile]
  }
  mkdirSync(getMCodeProfileDirectory(profile.id, userDataPath), { recursive: true })
  writeProfileIndex(getMCodeProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles,
    profile
  }
}

export function setActiveMCodeProfile(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): MCodeProfileListState {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  let found = false
  const profiles = index.profiles.map((profile) => {
    if (profile.id !== profileId) {
      return profile
    }
    found = true
    return {
      ...profile,
      updatedAt: now,
      lastOpenedAt: now
    }
  })
  if (!found) {
    throw new Error('unknown_mcode_profile')
  }
  const nextIndex: MCodeProfileIndex = {
    ...index,
    activeProfileId: profileId,
    profiles
  }
  mkdirSync(getMCodeProfileDirectory(profileId, userDataPath), { recursive: true })
  writeProfileIndex(getMCodeProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles
  }
}
