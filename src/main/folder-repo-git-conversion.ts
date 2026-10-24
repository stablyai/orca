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

/** Require the project itself to be the Git root; stamp Git’s spelling to preserve workspace ids. */
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

/** Prove local folder-to-Git changes before writing; SSH projects cannot be probed here. */
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

/** Stamp the proven root immediately after setup succeeds, with no intervening await. */
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

/** Recheck after Git yields: new folder workspaces may prevent conversion of a finished clone. */
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
