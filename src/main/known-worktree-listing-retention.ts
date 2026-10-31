import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { isFolderRepo } from '../shared/repo-kind'
import type { Repo } from '../shared/repo-types'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  getRepoIdFromWorktreeId,
  splitWorktreeId
} from '../shared/worktree/id'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { areWorktreePathsEqual, canonicalWorktreePath } from './git/worktree-path-comparison'
import { readCheckedOutBranchRef, readWorktreeHeadOid } from './git/worktree-list-reader'
import { localWorktreePathsExistOrAreUnverifiable } from './local-worktree-path-presence'
import type { Store } from './persistence/loading-store/store'
import { readAllWorktreeMetaForRepo } from './persistence/host-qualified-worktree-meta'
import {
  addWorkspaceSessionWorktreeOwners,
  getPersistedWorktreeOwnerId
} from './persistence/restoring-sessions/session-worktree-ownership'
import { getLocalProjectWorktreeGitOptions } from './project-runtime-git-options'
import { failedWorktreeRemovals, pendingWorktreeRemovals } from './worktree-removal-table'

type KnownWorktreePath = { path: string; hasSession: boolean }

/** Paths of this repo's worktrees that hold saved settings or saved tabs on the repo's host. */
function readKnownWorktreePaths(store: Store, repo: Repo): KnownWorktreePath[] {
  const sessionIds = new Set<string>()
  // Optional like the sibling row builder's meta reads: partial stores still list their rows.
  const session = store.getWorkspaceSession?.(getRepoExecutionHostId(repo))
  if (session) {
    addWorkspaceSessionWorktreeOwners(session, {
      owners: sessionIds,
      addOwner: (ownerKey) => {
        const worktreeId = getPersistedWorktreeOwnerId(ownerKey)
        if (worktreeId) {
          sessionIds.add(worktreeId)
        }
      }
    })
  }
  const known = new Map<string, KnownWorktreePath>()
  for (const worktreeId of [
    ...sessionIds,
    ...Object.keys(readAllWorktreeMetaForRepo(store, repo))
  ]) {
    const path = splitWorktreeId(worktreeId)?.worktreePath
    // Folder workspaces share one directory between sessions and are never listed by Git.
    if (
      !path ||
      getRepoIdFromWorktreeId(worktreeId) !== repo.id ||
      path.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR) ||
      known.has(path)
    ) {
      continue
    }
    known.set(path, { path, hasSession: sessionIds.has(worktreeId) })
  }
  return [...known.values()]
}

/** Several saved spellings of one folder: the one holding tabs wins, then Git's own, then the first. */
function pickKnownSpelling(listedPath: string, spellings: KnownWorktreePath[]): string {
  const withSession = spellings.filter((spelling) => spelling.hasSession)
  const candidates = withSession.length > 0 ? withSession : spellings
  return (candidates.find((spelling) => spelling.path === listedPath) ?? candidates[0]).path
}

function isOwnedByOrcaRemoval(repo: Repo, path: string): boolean {
  return [...pendingWorktreeRemovals.values(), ...failedWorktreeRemovals.values()].some(
    (record) => record.repoId === repo.id && areWorktreePathsEqual(record.worktreePath, path)
  )
}

/**
 * A listing names worktrees but cannot prove one is gone: Git may spell the same folder differently
 * (WSL vs native Git), refuse, or print cut-off output. Saved worktrees keep the spelling Orca already
 * uses, and one the listing omits stays listed until its folder is proven absent in a repo Git read.
 */
export async function retainKnownWorktreesInListing(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[]
): Promise<GitWorktreeInfo[]> {
  // Only a listing that runs beside the files can probe them; SSH listings already keep stored rows.
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID || isFolderRepo(repo)) {
    return gitWorktrees
  }
  const known = readKnownWorktreePaths(store, repo)
  if (known.length === 0) {
    return gitWorktrees
  }
  const knownByKey = new Map<string, KnownWorktreePath[]>()
  for (const spelling of known) {
    const key = canonicalWorktreePath(spelling.path)
    knownByKey.set(key, [...(knownByKey.get(key) ?? []), spelling])
  }
  const listedKeys = new Set<string>()
  const listed = gitWorktrees.map((row) => {
    const key = canonicalWorktreePath(row.path)
    listedKeys.add(key)
    const spellings = knownByKey.get(key)
    const path = spellings ? pickKnownSpelling(row.path, spellings) : row.path
    return path === row.path ? row : { ...row, path }
  })
  const unlisted = [...knownByKey.entries()]
    .filter(([key]) => !listedKeys.has(key))
    .map(([, spellings]) => pickKnownSpelling('', spellings))
    .filter((path) => !isOwnedByOrcaRemoval(repo, path))
  if (unlisted.length === 0) {
    return listed
  }

  // Git always lists the main checkout first; without it the repo itself was not read (empty or
  // refused output, an unmounted volume), and a missing child folder there proves nothing.
  const repoWasRead = gitWorktrees.some((worktree) => worktree.isMainWorktree)
  // A timeout or permission error is not absence either.
  const presence = repoWasRead ? await localWorktreePathsExistOrAreUnverifiable(unlisted) : null
  const present = unlisted.filter((path) => presence?.get(path) ?? true)
  if (present.length === 0) {
    return listed
  }
  // Re-read after the probes: a worktree Orca deleted meanwhile must not come back.
  const stillKnown = new Set(readKnownWorktreePaths(store, repo).map((spelling) => spelling.path))
  const retainedPaths = present.filter(
    (path) => stillKnown.has(path) && !isOwnedByOrcaRemoval(repo, path)
  )
  if (retainedPaths.length === 0) {
    return listed
  }
  const gitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  const retained = await Promise.all(
    retainedPaths.map(async (path): Promise<GitWorktreeInfo> => ({
      path,
      // An empty branch would read as a branch switch and clear the worktree's review links.
      head: await readWorktreeHeadOid(path, gitOptions),
      branch: (await readCheckedOutBranchRef(path, gitOptions)) ?? '',
      isBare: false,
      isMainWorktree: areWorktreePathsEqual(path, repo.path)
    }))
  )
  return [...listed, ...retained]
}
