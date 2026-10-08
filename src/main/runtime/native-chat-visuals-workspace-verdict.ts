// Whether the local workspace a chat ran in is provably gone, for the visuals folder sweep.
// Chat records and visuals live at the user-data root, shared by every Orca profile, while each
// profile keeps its own workspace catalog: so only absence from EVERY profile's catalog counts. A
// worktree still in a known project is gone only when git itself no longer records it. Never runs
// git or lists a repo's worktrees: that walk can touch protected folders.

import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../shared/floating-workspace-worktree'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../shared/workspace-scope'
import type { Store } from '../persistence'
import { readOtherProfileWorkspaceCatalog } from '../orca-profiles/other-profile-workspace-catalog'
import {
  getOrcaProfilesDirectory,
  getProfileUserDataPath
} from '../orca-profiles/profile-storage-paths'
import type { NativeChatVisualsWorkspaceVerdict } from '../native-chat/native-chat-visuals-sweep'

/** This profile's live catalog and every other profile's persisted one. The running profile is
 *  named by its own storage folder, not the profile index, which a switch rewrites first. */
export function readNativeChatVisualsWorkspaceCatalogs(
  store: NativeChatVisualsWorkspaceCatalogs['active'] & Pick<Store, 'getProfileStorageDirectory'>,
  userDataPath = getProfileUserDataPath()
): NativeChatVisualsWorkspaceCatalogs {
  const storage = store.getProfileStorageDirectory()
  const runningProfileId = samePath(dirname(storage), getOrcaProfilesDirectory(userDataPath))
    ? basename(storage)
    : undefined
  return {
    active: store,
    others: readOtherProfileWorkspaceCatalog(userDataPath, {
      ...(runningProfileId ? { runningProfileId } : {}),
      // Chat records are never deleted, so this rule is what cleans up; a profile created but never
      // opened must not switch it off.
      neverWrittenIsEmpty: true
    })
  }
}

export type NativeChatVisualsWorkspaceCatalogs = {
  /** The running profile's live catalog: the Store, narrowed to what a verdict reads. */
  active: {
    getRepo: (id: string) => { path: string } | undefined
    getAllWorktreeMeta: () => Readonly<Record<string, unknown>>
    getFolderWorkspaces: () => readonly { id: string }[]
  }
  /** Every other profile's worktree ids, folder workspace keys and project ids. */
  others: { ids: ReadonlySet<string>; repoIds: ReadonlySet<string>; unreadableProfiles: number }
}

export type NativeChatVisualsFilesystem = {
  /** `present`, `absent` (definitively), or `unknown` for any other answer. */
  presence: (path: string) => Promise<'present' | 'absent' | 'unknown'>
  /** Whether git in the repo at `repoPath` records a linked worktree at `worktreePath`; null when
   *  its records can't be read. */
  gitRecordsWorktree: (repoPath: string, worktreePath: string) => Promise<boolean | null>
}

async function presence(path: string): Promise<'present' | 'absent' | 'unknown'> {
  try {
    await stat(path)
    return 'present'
  } catch (error) {
    return isDefinitiveAbsence(error) ? 'absent' : 'unknown'
  }
}

const samePath = (left: string, right: string): boolean =>
  normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)

async function gitRecordsWorktree(repoPath: string, worktreePath: string): Promise<boolean | null> {
  const gitDir = join(repoPath, '.git')
  try {
    // A `.git` file (the repo is itself a linked worktree or a submodule) is not read here.
    if (!(await lstat(gitDir)).isDirectory()) {
      return null
    }
    let names: string[]
    try {
      names = await readdir(join(gitDir, 'worktrees'))
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return false
      }
      throw error
    }
    for (const name of names) {
      let recorded: string
      try {
        recorded = await readFile(join(gitDir, 'worktrees', name, 'gitdir'), 'utf8')
      } catch (error) {
        if (isDefinitiveAbsence(error)) {
          continue
        }
        throw error
      }
      // The record names the worktree's own `.git` file; git 2.48+ may write it relative to the
      // record folder's real path, which differs from the stored one when that runs through a link.
      const gitFile = recorded.trim()
      const absolute = isAbsolute(gitFile)
        ? gitFile
        : resolve(await realpath(join(gitDir, 'worktrees', name)), gitFile)
      if (samePath(dirname(absolute), worktreePath)) {
        return true
      }
    }
    return false
  } catch {
    return null
  }
}

const NODE_FILESYSTEM: NativeChatVisualsFilesystem = { presence, gitRecordsWorktree }

async function worktreeVerdict(
  catalogs: NativeChatVisualsWorkspaceCatalogs,
  workspaceId: string,
  fs: NativeChatVisualsFilesystem
): Promise<NativeChatVisualsWorkspaceVerdict> {
  const worktree = splitWorktreeIdForFilesystem(workspaceId)
  if (!worktree?.repoId || !worktree.worktreePath) {
    return 'unverifiable'
  }
  const repo = catalogs.active.getRepo(worktree.repoId)
  // The project was removed from Orca in every profile.
  if (!repo && !catalogs.others.repoIds.has(worktree.repoId)) {
    return 'removed'
  }
  if (
    Object.hasOwn(catalogs.active.getAllWorktreeMeta(), workspaceId) ||
    catalogs.others.ids.has(workspaceId)
  ) {
    return 'present'
  }
  // The project's own checkout, or one only another profile can say anything about.
  if (!repo || samePath(repo.path, worktree.worktreePath)) {
    return 'unverifiable'
  }
  const own = await fs.presence(worktree.worktreePath)
  if (own !== 'absent') {
    return own === 'present' ? 'present' : 'unverifiable'
  }
  // A worktree on an unmounted drive is still recorded by git, so absence alone proves nothing.
  if ((await fs.presence(repo.path)) !== 'present') {
    return 'unverifiable'
  }
  return (await fs.gitRecordsWorktree(repo.path, worktree.worktreePath)) === false
    ? 'removed'
    : 'unverifiable'
}

/**
 * A verdict function over one snapshot of every profile's catalog; call once per sweep run.
 * Null catalogs, or any profile whose state can't be read, decide nothing.
 */
export function createNativeChatVisualsWorkspaceVerdicts(
  readCatalogs: () => NativeChatVisualsWorkspaceCatalogs | null,
  fs: NativeChatVisualsFilesystem = NODE_FILESYSTEM
): () => (location: AgentSessionExecutionLocation) => Promise<NativeChatVisualsWorkspaceVerdict> {
  return () => {
    let snapshot: NativeChatVisualsWorkspaceCatalogs | null | undefined
    const catalogs = (): NativeChatVisualsWorkspaceCatalogs | null => {
      if (snapshot === undefined) {
        try {
          snapshot = readCatalogs()
        } catch {
          snapshot = null
        }
      }
      return snapshot && snapshot.others.unreadableProfiles === 0 ? snapshot : null
    }
    return async (location) => {
      // Another host or a WSL distro owns its own answer; loss of contact is never removal.
      if (location.executionHostId !== LOCAL_EXECUTION_HOST_ID || location.wslDistro !== null) {
        return 'unverifiable'
      }
      // The floating workspace names a setting, not a place the user removes.
      if (isFloatingWorkspaceId(location.workspaceId)) {
        return 'unverifiable'
      }
      const known = catalogs()
      if (!known) {
        return 'unverifiable'
      }
      if (location.workspaceKind !== 'folder') {
        return worktreeVerdict(known, location.workspaceId, fs)
      }
      if (parseWorkspaceKey(location.workspaceId)?.type !== 'folder') {
        return 'unverifiable'
      }
      const listed =
        known.others.ids.has(location.workspaceId) ||
        known.active
          .getFolderWorkspaces()
          .some((workspace) => folderWorkspaceKey(workspace.id) === location.workspaceId)
      return listed ? 'present' : 'removed'
    }
  }
}
