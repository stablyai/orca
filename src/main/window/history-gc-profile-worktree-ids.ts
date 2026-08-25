import { readFileSync } from 'node:fs'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import {
  getOrcaProfileDataFile,
  getProfileUserDataPath
} from '../orca-profiles/profile-storage-paths'
import { getOrcaProfileIndexPath, readProfileIndex } from '../orca-profiles/profile-index-store'

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
 * Reading their data files directly is deliberate: a Store per profile would
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
    const collected = readProfileWorktreeIds(getOrcaProfileDataFile(profile.id, userDataPath))
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

function readProfileWorktreeIds(dataFile: string): Set<string> | null {
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
