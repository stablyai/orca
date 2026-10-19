import { realpathSync } from 'node:fs'
import type { Repo } from '../shared/repo-types'
import type {
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult
} from '../shared/project-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../shared/execution-host'
import type { Store } from './persistence'
import { isFolderRepo } from '../shared/repo-kind'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import { getGitRepoRootAsync, isGitRepoAsync } from './git/repo'
import { findExtraFolderWorkspaceIds } from './folder-workspace-meta-presence'
import { findProjectHostSetup } from '../shared/project-host-setup-target'

export type FolderToGitConversion = {
  updates: Pick<Repo, 'folderUpgradeGitRootPath'>
  /** Git spells the root exactly as the project does, so its external worktrees can be told apart. */
  rootSpellingMatches: boolean
}

function resolveRealPath(pathValue: string): string {
  try {
    return realpathSync(pathValue)
  } catch {
    return pathValue
  }
}

/**
 * Git's verdict on a folder project's path, or null when it must stay a folder project.
 *
 * Refuse unless the folder *is* the work-tree root: git accepts any path inside a work tree, so a
 * project inside another repo would otherwise flip. The stamped root lets the listing map Git's
 * spelling back to the project's path, so the main workspace keeps its id (and its tabs).
 */
export async function resolveFolderToGitConversion(
  repoPath: string
): Promise<FolderToGitConversion | null> {
  if (!(await isGitRepoAsync(repoPath))) {
    return null
  }
  const gitRoot = await getGitRepoRootAsync(repoPath)
  if (resolveRealPath(gitRoot) !== resolveRealPath(repoPath)) {
    return null
  }
  return {
    updates: { folderUpgradeGitRootPath: gitRoot },
    rootSpellingMatches:
      normalizeRuntimePathForComparison(gitRoot) === normalizeRuntimePathForComparison(repoPath)
  }
}

/**
 * The extra fields a manual change of `repo` to `nextKind` must write with it. Throws when a
 * folder project's path is not a Git root, so callers write nothing. An SSH project's Git runs on
 * a host this process can't probe, so it keeps the unverified change it had before.
 */
export async function proveRepoKindChange(
  repo: Repo | undefined,
  nextKind: Repo['kind'] | undefined,
  allowRuntimeHost = false
): Promise<Pick<Repo, 'folderUpgradeGitRootPath'>> {
  if (!repo || nextKind !== 'git' || !isFolderRepo(repo) || repo.connectionId) {
    return {}
  }
  const hostId = getRepoExecutionHostId(repo)
  if (
    hostId !== LOCAL_EXECUTION_HOST_ID &&
    !(allowRuntimeHost && parseExecutionHostId(hostId)?.kind === 'runtime')
  ) {
    return {}
  }
  const conversion = await resolveFolderToGitConversion(repo.path)
  if (!conversion) {
    throw new Error(
      `${repo.path} isn't the top folder of a Git repository, so this project's type was not changed.`
    )
  }
  return conversion.updates
}

/** Recheck the selected row after Git yields, then apply the synchronous write to that row. */
export async function commitProvenRepoKindChange<T>(
  store: Pick<Store, 'getRepos'>,
  repo: Repo,
  commit: (proven: Pick<Repo, 'folderUpgradeGitRootPath'>) => T,
  allowRuntimeHost = false
): Promise<T> {
  const proven = await proveRepoKindChange(repo, 'git', allowRuntimeHost)
  const current = store
    .getRepos()
    .find(
      (entry) =>
        entry.id === repo.id && getRepoExecutionHostId(entry) === getRepoExecutionHostId(repo)
    )
  if (!current || current.path !== repo.path || !isFolderRepo(current)) {
    throw new Error(
      'The project changed while Orca was checking it, so its type was not changed. Try again.'
    )
  }
  return commit(proven)
}

type ProjectHostSetupStore = Pick<Store, 'getRepos' | 'updateRepo'> & {
  getProjectHostSetups?: Store['getProjectHostSetups']
}

/**
 * A project setup update whose type change is proven first. The proven root is stamped right after
 * the setup write, with no await between, so nothing observes the project in between; a refused
 * setup write (folder workspaces a Git project can't show) throws before the stamp.
 */
export async function updateProjectHostSetupWithProvenKind(
  store: ProjectHostSetupStore,
  updateSetup: Store['updateProjectHostSetup'],
  args: ProjectHostSetupUpdateArgs,
  allowRuntimeHost = false
): Promise<ProjectHostSetupUpdateResult | null> {
  if (args.updates.kind !== 'git') {
    return updateSetup(args)
  }
  const setup = findProjectHostSetup(store.getProjectHostSetups?.() ?? [], args)
  const repo = setup?.repoId
    ? store
        .getRepos()
        .find(
          (entry) => entry.id === setup.repoId && getRepoExecutionHostId(entry) === setup.hostId
        )
    : undefined
  if (!repo || !isFolderRepo(repo)) {
    return updateSetup(args)
  }
  return commitProvenRepoKindChange(
    store,
    repo,
    (proven) => {
      const result = updateSetup(args)
      if (!result?.repo || !proven.folderUpgradeGitRootPath) {
        return result
      }
      const stamped = store.updateRepo(result.repo, proven)
      return stamped ? { ...result, repo: stamped } : result
    },
    allowRuntimeHost
  )
}

/**
 * The fields that turn a folder project a clone just landed in into a Git project, or null to keep
 * it a folder project (other folder workspaces, or not a Git root). Re-checks after the Git probe:
 * a workspace created meanwhile would otherwise make the write refuse a finished clone.
 */
export async function resolveClonedFolderConversion(
  store: Pick<Store, 'getAllWorktreeMeta'>,
  repo: Repo
): Promise<Pick<Repo, 'folderUpgradeGitRootPath'> | null> {
  const hasOtherWorkspaces = (): boolean =>
    findExtraFolderWorkspaceIds(repo, store.getAllWorktreeMeta()).length > 0
  if (!isFolderRepo(repo) || hasOtherWorkspaces()) {
    return null
  }
  const conversion = await resolveFolderToGitConversion(repo.path)
  return conversion && !hasOtherWorkspaces() ? conversion.updates : null
}
