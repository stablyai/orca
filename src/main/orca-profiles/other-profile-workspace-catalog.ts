import { lstatSync, readFileSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile,
  getProfileUserDataPath
} from './profile-storage-paths'
import { getOrcaProfileIndexPath, readProfileIndex } from './profile-index-store'
import { readProfileStateDomains } from '../persistence/profile-state/profile-state-domain-reader'
import { assertNoRetainedProfileStateExports } from '../persistence/profile-state/profile-state-recovery-required'
import {
  PROFILE_STATE_LEGACY_BACKUP_COUNT,
  profileStateLegacyBackupPath
} from '../persistence/profile-state/legacy-json/profile-state-legacy-backup-path'

/**
 * Worktree ids owned by Orca profiles OTHER than the running one.
 *
 * Why the history GC needs these: terminal history is keyed by worktree id
 * under `userData/terminal-history`, which has no profile segment, and fish
 * history lands in the user's own fish data dir — but the Store the GC asks for
 * live ids only ever reads the ACTIVE profile's data file. So after a profile
 * switch every other profile's history looks orphaned, and the GC deletes shell
 * history those profiles are still using.
 *
 * Reading their persisted state directly is deliberate: a Store per profile would
 * run migrations and normalization against state another profile owns. Only the
 * id-bearing collections are read, and any unreadable profile is skipped —
 * a profile whose ids cannot be established must widen the live set's
 * uncertainty, never narrow it, so failure here is handled by the caller
 * refusing to prune rather than by pruning more.
 */
export function getOtherProfileWorktreeIdsForHistoryGc(userDataPath = getProfileUserDataPath()): {
  ids: Set<string>
  unreadableProfiles: number
} {
  const { ids, unreadableProfiles } = readOtherProfileWorkspaceCatalog(userDataPath)
  return { ids, unreadableProfiles }
}

type ProfileWorkspaceIds = {
  /** Worktree ids with metadata, and folder workspace keys. */
  ids: Set<string>
  repoIds: Set<string>
}

export type OtherProfileCatalogOptions = {
  /** The profile this process runs, whose catalog the caller reads live. Defaults to the index's
   *  active profile, which a profile switch rewrites before the running one exits. */
  runningProfileId?: string
  /** A profile with no state database, sidecar or data file at all has never been written and
   *  holds nothing; by default it counts as unreadable like a missing file anywhere else. */
  neverWrittenIsEmpty?: boolean
}

/** The workspaces and projects every profile other than the running one holds. Any profile whose
 *  state can't be read is counted, never skipped silently: its ids are unknown. */
export function readOtherProfileWorkspaceCatalog(
  userDataPath = getProfileUserDataPath(),
  options: OtherProfileCatalogOptions = {}
): ProfileWorkspaceIds & { unreadableProfiles: number } {
  const ids = new Set<string>()
  const repoIds = new Set<string>()
  const index = readProfileIndex(getOrcaProfileIndexPath(userDataPath))
  if (!index) {
    return { ids, repoIds, unreadableProfiles: 0 }
  }
  let unreadableProfiles = 0
  const running = options.runningProfileId ?? index.activeProfileId
  for (const profile of index.profiles) {
    if (profile.id === running) {
      continue
    }
    const collected = readProfileWorktreeIds(profile.id, userDataPath, options)
    if (!collected) {
      unreadableProfiles += 1
      continue
    }
    collected.ids.forEach((id) => ids.add(id))
    collected.repoIds.forEach((id) => repoIds.add(id))
  }
  return { ids, repoIds, unreadableProfiles }
}

function readProfileWorktreeIds(
  profileId: string,
  userDataPath: string,
  options: OtherProfileCatalogOptions = {}
): ProfileWorkspaceIds | null {
  const databaseFile = getOrcaProfileStateDatabaseFile(profileId, userDataPath)
  // A present database is authoritative. In particular, do not fall back to a
  // stale JSON export after corruption or a future schema, because that could
  // make live history look orphaned and delete it.
  const databasePresence = profileStateDatabasePresence(databaseFile)
  if (databasePresence === 'present') {
    return readProfileWorktreeIdsFromDatabase(databaseFile, profileId)
  }
  if (databasePresence === 'unreadable') {
    return null
  }
  const dataFile = getOrcaProfileDataFile(profileId, userDataPath)
  try {
    assertNoRetainedProfileStateExports({ dataFile, databaseFile, profileId })
  } catch {
    return null
  }
  if (options.neverWrittenIsEmpty && neverWritten(dataFile)) {
    return { ids: new Set(), repoIds: new Set() }
  }
  return readProfileWorktreeIdsFromJson(dataFile)
}

/** No data file and none of Orca's own backups of it: a lost primary file is not a fresh profile. */
function neverWritten(dataFile: string): boolean {
  for (let index = 0; index < PROFILE_STATE_LEGACY_BACKUP_COUNT; index += 1) {
    if (!definitivelyAbsent(profileStateLegacyBackupPath(dataFile, index))) {
      return false
    }
  }
  return definitivelyAbsent(dataFile)
}

function definitivelyAbsent(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    return isDefinitiveAbsence(error)
  }
}

function profileStateDatabasePresence(path: string): 'absent' | 'present' | 'unreadable' {
  let mainDatabasePresent = false
  try {
    lstatSync(path)
    mainDatabasePresent = true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      mainDatabasePresent = false
    } else {
      return 'unreadable'
    }
  }
  if (mainDatabasePresent) {
    return 'present'
  }
  for (const sidecar of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try {
      lstatSync(sidecar)
      return 'unreadable'
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        return 'unreadable'
      }
    }
  }
  return 'absent'
}

function readProfileWorktreeIdsFromDatabase(
  databaseFile: string,
  profileId: string
): ProfileWorkspaceIds | null {
  const domains = readProfileStateDomains(databaseFile, profileId, [
    'worktreeMeta',
    'folderWorkspaces',
    'repos'
  ])
  if (domains.kind === 'unreadable') {
    return null
  }

  const ids = new Set<string>()
  const worktreeMeta = domains.values.get('worktreeMeta')
  if (worktreeMeta !== undefined) {
    if (worktreeMeta === null) {
      // Explicit null is a valid legacy state value and means no metadata.
    } else if (!isRecord(worktreeMeta)) {
      return null
    } else {
      for (const id of Object.keys(worktreeMeta)) {
        ids.add(id)
      }
    }
  }
  const folderWorkspaces = domains.values.get('folderWorkspaces')
  if (folderWorkspaces !== undefined) {
    if (folderWorkspaces === null) {
      // Explicit null is a valid legacy state value and means no workspaces.
    } else if (!Array.isArray(folderWorkspaces)) {
      return null
    } else {
      for (const workspace of folderWorkspaces) {
        const id = isRecord(workspace) ? workspace.id : undefined
        if (typeof id === 'string' && id) {
          ids.add(folderWorkspaceKey(id))
        }
      }
    }
  }
  const repoIds = repoIdsOf(domains.values.get('repos'))
  return repoIds ? { ids, repoIds } : null
}

/** Null when the collection is present but not a list: its ids are unknown. */
function repoIdsOf(repos: unknown): Set<string> | null {
  const ids = new Set<string>()
  if (repos === undefined || repos === null) {
    return ids
  }
  if (!Array.isArray(repos)) {
    return null
  }
  for (const repo of repos) {
    const id = isRecord(repo) ? repo.id : undefined
    if (typeof id === 'string' && id) {
      ids.add(id)
    }
  }
  return ids
}

function readProfileWorktreeIdsFromJson(dataFile: string): ProfileWorkspaceIds | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(dataFile, 'utf8'))
  } catch {
    // Missing is indistinguishable from corrupt here, and both mean the same
    // thing to the caller: this profile's ids are unknown.
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  const state = parsed
  const ids = new Set<string>()
  if (state.worktreeMeta && typeof state.worktreeMeta === 'object') {
    for (const id of Object.keys(state.worktreeMeta)) {
      ids.add(id)
    }
  }
  if (Array.isArray(state.folderWorkspaces)) {
    for (const workspace of state.folderWorkspaces) {
      const id = isRecord(workspace) ? workspace.id : undefined
      if (typeof id === 'string' && id) {
        ids.add(folderWorkspaceKey(id))
      }
    }
  }
  const repoIds = repoIdsOf(state.repos)
  return repoIds ? { ids, repoIds } : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
