import { lstatSync, readFileSync } from 'node:fs'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile,
  getProfileUserDataPath,
  getOrcaProfileIndexPath
} from '../profile-storage-paths'
import { readProfileIndex } from '../profile-index-store'
import { readProfileStateDomains } from '../../persistence/profile-state/documents/profile-state-domain-reader'
import { assertNoRetainedProfileStateExports } from '../../persistence/profile-state/recovery/profile-state-recovery-required'

/** Histories lack profile segments, so include inactive profiles before GC.
 * Read persisted IDs without Store migrations; unreadable profiles must prevent pruning. */
export function getOtherProfileWorktreeIdsForHistoryGc(
  userDataPath = getProfileUserDataPath()
): ProfileWorkspaceIds & { unreadableProfiles: number } {
  return readOtherProfileWorkspaceCatalog(userDataPath)
}

type ProfileWorkspaceIds = {
  ids: Set<string>
  repoIds: Set<string>
}

/** Report unreadable inactive profiles explicitly: their IDs remain unknown. */
export function readOtherProfileWorkspaceCatalog(
  userDataPath = getProfileUserDataPath()
): ProfileWorkspaceIds & { unreadableProfiles: number } {
  const ids = new Set<string>()
  const repoIds = new Set<string>()
  const index = readProfileIndex(getOrcaProfileIndexPath(userDataPath))
  if (!index) {
    return { ids, repoIds, unreadableProfiles: 0 }
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
    collected.ids.forEach((id) => ids.add(id))
    collected.repoIds.forEach((id) => repoIds.add(id))
  }
  return { ids, repoIds, unreadableProfiles }
}

function readProfileWorktreeIds(
  profileId: string,
  userDataPath: string
): ProfileWorkspaceIds | null {
  const databaseFile = getOrcaProfileStateDatabaseFile(profileId, userDataPath)
  // A present database is authoritative; stale JSON fallback could falsely orphan live history.
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
      // Null is valid legacy state with no metadata.
    } else if (!isRecord(worktreeMeta)) {
      return null
    } else {
      addWorktreeMetaIds(worktreeMeta, ids)
    }
  }
  const folderWorkspaces = domains.values.get('folderWorkspaces')
  if (folderWorkspaces !== undefined) {
    if (folderWorkspaces === null) {
      // Null is valid legacy state with no workspaces.
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
    // Missing and corrupt both leave this profile’s IDs unknown.
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  const state = parsed
  const ids = new Set<string>()
  if (isRecord(state.worktreeMeta)) {
    addWorktreeMetaIds(state.worktreeMeta, ids)
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

/** Prior ids count: a renamed worktree's panes keep session ids embedding its old path. */
function addWorktreeMetaIds(worktreeMeta: Record<string, unknown>, ids: Set<string>): void {
  for (const [id, meta] of Object.entries(worktreeMeta)) {
    ids.add(id)
    const prior = isRecord(meta) ? meta.priorWorktreeIds : undefined
    if (Array.isArray(prior)) {
      prior.forEach((priorId) => typeof priorId === 'string' && ids.add(priorId))
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
