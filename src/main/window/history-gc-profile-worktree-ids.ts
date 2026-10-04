import { lstatSync, readFileSync } from 'node:fs'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile,
  getProfileUserDataPath
} from '../orca-profiles/profile-storage-paths'
import { getOrcaProfileIndexPath, readProfileIndex } from '../orca-profiles/profile-index-store'
import { readProfileStateDomains } from '../persistence/profile-state/profile-state-domain-reader'
import { assertNoRetainedProfileStateExports } from '../persistence/profile-state/profile-state-recovery-required'

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
 * two id-bearing collections are read, and any unreadable profile is skipped —
 * a profile whose ids cannot be established must widen the live set's
 * uncertainty, never narrow it, so failure here is handled by the caller
 * refusing to prune rather than by pruning more.
 */
export function getOtherProfileWorktreeIdsForHistoryGc(userDataPath = getProfileUserDataPath()): {
  ids: Set<string>
  unreadableProfiles: number
} {
  const ids = new Set<string>()
  const index = readProfileIndex(getOrcaProfileIndexPath(userDataPath))
  if (!index) {
    return { ids, unreadableProfiles: 0 }
  }
  let unreadableProfiles = 0
  for (const profile of index.profiles) {
    if (profile.id === index.activeProfileId) {
      continue
    }
    const collected = readProfileWorktreeIds(profile.id, userDataPath)
    if (!collected) {
      unreadableProfiles += 1
      continue
    }
    for (const id of collected) {
      ids.add(id)
    }
  }
  return { ids, unreadableProfiles }
}

function readProfileWorktreeIds(profileId: string, userDataPath: string): Set<string> | null {
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
  return readProfileWorktreeIdsFromJson(dataFile)
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
): Set<string> | null {
  const domains = readProfileStateDomains(databaseFile, profileId, [
    'worktreeMeta',
    'folderWorkspaces'
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
  return ids
}

function readProfileWorktreeIdsFromJson(dataFile: string): Set<string> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(dataFile, 'utf8'))
  } catch {
    // Missing is indistinguishable from corrupt here, and both mean the same
    // thing to the caller: this profile's ids are unknown.
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const state = parsed as { worktreeMeta?: unknown; folderWorkspaces?: unknown }
  const ids = new Set<string>()
  if (state.worktreeMeta && typeof state.worktreeMeta === 'object') {
    for (const id of Object.keys(state.worktreeMeta)) {
      ids.add(id)
    }
  }
  if (Array.isArray(state.folderWorkspaces)) {
    for (const workspace of state.folderWorkspaces) {
      const id = (workspace as { id?: unknown } | null)?.id
      if (typeof id === 'string' && id) {
        ids.add(folderWorkspaceKey(id))
      }
    }
  }
  return ids
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
