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
import {
  createDefaultLocalOrcaProfile,
  DEFAULT_LOCAL_ORCA_PROFILE_ID,
  DEFAULT_LOCAL_ORCA_PROFILE_NAME,
  ORCA_PROFILE_INDEX_SCHEMA_VERSION,
  type CreateLocalOrcaProfileArgs,
  type CreateLocalOrcaProfileResult,
  type OrcaProfileIndex,
  type OrcaProfileListState,
  type OrcaProfileSummary
} from '../../shared/orca-profiles'
import {
  getOrcaProfileDataFile,
  getOrcaProfileDirectory,
  getOrcaProfileIndexPath,
  getOrcaProfileStateDatabaseFile,
  hasOrcaProfileStateDatabase,
  getProfileUserDataPath
} from './profile-storage-paths'
import { copyLegacyStateToProfile } from './profile-legacy-state-import'
import { profileStateJsonExportPaths } from '../persistence/profile-state/legacy-json/profile-state-export-path'
import { hasProfileStateAuthorityMarker } from '../persistence/profile-state/profile-state-authority-marker'
import { profileStateDatabaseBackups } from '../persistence/profile-state/profile-state-backup-path'

export {
  getOrcaProfileBrowserSessionMetaFile,
  getOrcaProfileDataFile,
  getOrcaProfileDirectory,
  getOrcaProfileIndexPath,
  getOrcaProfileStateDatabaseFile,
  hasOrcaProfileStateDatabase,
  getOrcaProfilesDirectory,
  initOrcaProfilePaths
} from './profile-storage-paths'

export type ActiveOrcaProfileState = {
  index: OrcaProfileIndex
  profile: OrcaProfileSummary
  dataFile: string
  stateDatabaseFile: string
  profileDirectory: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProfileSummary(value: unknown): value is OrcaProfileSummary {
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

function normalizeProfileIndex(raw: unknown): OrcaProfileIndex | null {
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
    schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
    activeProfileId,
    profiles
  }
}

function sanitizeProfileName(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed.slice(0, 80) : 'New Profile'
}

function readProfileIndexFile(indexPath: string): OrcaProfileIndex | null {
  try {
    return normalizeProfileIndex(JSON.parse(readFileSync(indexPath, 'utf-8')))
  } catch {
    return null
  }
}

export function readProfileIndex(indexPath: string): OrcaProfileIndex | null {
  // Why: a torn/corrupt index must not silently reset the app to a single
  // default profile — that would orphan every other profile's data directory.
  return readProfileIndexFile(indexPath) ?? readProfileIndexFile(`${indexPath}.bak`)
}

function readExistingProfileIndex(indexPath: string): OrcaProfileIndex | null {
  const index = readProfileIndex(indexPath)
  if (!index && (existsSync(indexPath) || existsSync(`${indexPath}.bak`))) {
    throw new Error(`Could not read active profile index ${indexPath}`)
  }
  return index
}

export function writeProfileIndex(indexPath: string, index: OrcaProfileIndex): void {
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

export { seedNewOrcaProfileTelemetryConsent } from './profile-telemetry-consent-seed'

function createInitialProfileIndex(now = Date.now()): OrcaProfileIndex {
  const profile = createDefaultLocalOrcaProfile(now)
  return {
    schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
    activeProfileId: profile.id,
    profiles: [profile]
  }
}

export function loadOrCreateProfileIndex(userDataPath: string): OrcaProfileIndex {
  const indexPath = getOrcaProfileIndexPath(userDataPath)
  const index = readExistingProfileIndex(indexPath)
  if (index) {
    return index
  }
  const nextIndex = createInitialProfileIndex()
  writeProfileIndex(indexPath, nextIndex)
  return nextIndex
}

function getActiveProfile(index: OrcaProfileIndex): OrcaProfileSummary {
  return (
    index.profiles.find((profile) => profile.id === index.activeProfileId) ??
    index.profiles[0] ??
    createDefaultLocalOrcaProfile(Date.now())
  )
}

export function ensureActiveOrcaProfile(
  userDataPath = getProfileUserDataPath()
): ActiveOrcaProfileState {
  const indexPath = getOrcaProfileIndexPath(userDataPath)
  let index = readExistingProfileIndex(indexPath)
  let shouldWriteIndex = !existsSync(indexPath)

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
  mkdirSync(profileDirectory, { recursive: true })
  const profileDatabaseFile = getOrcaProfileStateDatabaseFile(activeProfile.id, userDataPath)
  const profileDataFile = getOrcaProfileDataFile(activeProfile.id, userDataPath)
  let hasRetainedProfileStateAuthority = false
  try {
    hasRetainedProfileStateAuthority =
      hasProfileStateAuthorityMarker(profileDatabaseFile) ||
      profileStateJsonExportPaths(profileDataFile).length > 0 ||
      profileStateDatabaseBackups(profileDatabaseFile).length > 0
  } catch {
    // An unreadable profile directory must never trigger a fallback copy of legacy state.
    hasRetainedProfileStateAuthority = true
  }
  if (
    activeProfile.id === DEFAULT_LOCAL_ORCA_PROFILE_ID &&
    !hasOrcaProfileStateDatabase(activeProfile.id, userDataPath) &&
    !hasRetainedProfileStateAuthority
  ) {
    copyLegacyStateToProfile(userDataPath, activeProfile.id)
  }

  if (shouldWriteIndex) {
    writeProfileIndex(indexPath, index)
  }

  return {
    index,
    profile: activeProfile,
    dataFile: profileDataFile,
    stateDatabaseFile: profileDatabaseFile,
    profileDirectory
  }
}

export function isDefaultLocalOrcaProfileId(profileId: string): boolean {
  return profileId === DEFAULT_LOCAL_ORCA_PROFILE_ID
}

export function getOrcaProfileListState(
  userDataPath = getProfileUserDataPath()
): OrcaProfileListState {
  const { index } = ensureActiveOrcaProfile(userDataPath)
  return {
    activeProfileId: index.activeProfileId,
    profiles: index.profiles
  }
}

export function createLocalOrcaProfile(
  args: CreateLocalOrcaProfileArgs = {},
  userDataPath = getProfileUserDataPath()
): CreateLocalOrcaProfileResult {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  const name = sanitizeProfileName(args.name)
  const profile: OrcaProfileSummary = {
    id: `local-${randomUUID()}`,
    name,
    avatar: {
      kind: 'initials',
      initials: (
        name.match(/[A-Za-z0-9]/)?.[0] ?? DEFAULT_LOCAL_ORCA_PROFILE_NAME[0]
      ).toUpperCase(),
      color: 'neutral'
    },
    kind: 'local',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now
  }
  const nextIndex: OrcaProfileIndex = {
    ...index,
    profiles: [...index.profiles, profile]
  }
  mkdirSync(getOrcaProfileDirectory(profile.id, userDataPath), { recursive: true })
  writeProfileIndex(getOrcaProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles,
    profile
  }
}

export function setActiveOrcaProfile(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): OrcaProfileListState {
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
    throw new Error('unknown_orca_profile')
  }
  const nextIndex: OrcaProfileIndex = {
    ...index,
    activeProfileId: profileId,
    profiles
  }
  mkdirSync(getOrcaProfileDirectory(profileId, userDataPath), { recursive: true })
  writeProfileIndex(getOrcaProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles
  }
}
