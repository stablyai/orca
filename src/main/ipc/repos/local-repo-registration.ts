import type { Store } from '../../persistence/loading-store/store'
import type { Repo } from '../../../shared/repo-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { awaitWindowsHostGitEnvironmentReady } from '../../git/command-runner/host-routing/windows-host-git-environment'
import {
  inspectGitRepoForRegistrationAsync,
  getGitRepoRootAsync
} from '../../git/repositories/discovery/repo-detection'
import { getRepoName } from '../../git/repositories/repository-name'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { findProjectAtSameRealPath } from '../../workspaces/catalog/project-realpath-identity'
import { detectRepoLocalMetadata } from '../../repository-icons/repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../../workspaces/creation/worktree-root-preparation'
import { describeWslUncAccessDenied } from '../../wsl/filesystem/wsl-unc-access-denied'
import { createLocalProjectRecord } from '../../workspaces/catalog/local-project-record'

export async function addLocalRepoFromPath(
  store: Store,
  path: string,
  kind: 'git' | 'folder' = 'git',
  displayName?: string
): Promise<{ repo: Repo; alreadyExisted: boolean } | { error: string }> {
  const repoKind = kind === 'folder' ? 'folder' : 'git'
  if (repoKind === 'git') {
    await awaitWindowsHostGitEnvironmentReady({ cwd: path })
  }
  const gitInfo = repoKind === 'git' ? await inspectGitRepoForRegistrationAsync(path) : null
  if (gitInfo && !gitInfo.isRepo) {
    return {
      error:
        (await describeWslUncAccessDenied(path, store.getSettings())) ??
        `Not a valid git repository: ${path}`
    }
  }

  const resolvedPath = gitInfo?.rootPath ?? path
  const pathKey = normalizeRuntimePathForComparison(path)
  const existing = store
    .getRepos()
    .find((repo) => !repo.connectionId && normalizeRuntimePathForComparison(repo.path) === pathKey)
  if (existing) {
    return { repo: existing, alreadyExisted: true }
  }

  const resolvedPathKey = normalizeRuntimePathForComparison(resolvedPath)
  if (resolvedPathKey !== pathKey) {
    const existingAfterRootResolve = store
      .getRepos()
      .find(
        (repo) =>
          !repo.connectionId && normalizeRuntimePathForComparison(repo.path) === resolvedPathKey
      )
    if (existingAfterRootResolve) {
      return { repo: existingAfterRootResolve, alreadyExisted: true }
    }
  }
  const existingAtRealPath = await findProjectAtSameRealPath(
    store.getRepos().filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID),
    resolvedPath
  )
  if (existingAtRealPath) {
    return { repo: existingAtRealPath, alreadyExisted: true }
  }

  // Linked worktrees report their own toplevel; resolve the main checkout to avoid duplicate host setups.
  let mainRepoKey: string | null = null
  if (repoKind === 'git') {
    const mainRepoRoot = gitInfo?.mainRepoPath
      ? await getGitRepoRootAsync(gitInfo.mainRepoPath)
      : null
    if (mainRepoRoot) {
      mainRepoKey = normalizeRuntimePathForComparison(mainRepoRoot)
      // Only Git checkouts share project identity with their worktrees; folder records do not deduplicate them.
      const trackedMainRepo = store
        .getRepos()
        .find(
          (repo) =>
            !repo.connectionId &&
            !isFolderRepo(repo) &&
            normalizeRuntimePathForComparison(repo.path) === mainRepoKey
        )
      if (trackedMainRepo) {
        return { repo: trackedMainRepo, alreadyExisted: true }
      }
    }
  }

  const detected = await detectRepoLocalMetadata({
    repoPath: resolvedPath,
    kind: repoKind,
    executionHostId: LOCAL_EXECUTION_HOST_ID
  })
  // Another registration can finish while icon discovery is pending.
  const raceWinner = store.getRepos().find((repo) => {
    if (repo.connectionId) {
      return false
    }
    const repoPathKey = normalizeRuntimePathForComparison(repo.path)
    return (
      repoPathKey === pathKey ||
      repoPathKey === resolvedPathKey ||
      (mainRepoKey !== null && !isFolderRepo(repo) && repoPathKey === mainRepoKey)
    )
  })
  if (raceWinner) {
    return { repo: raceWinner, alreadyExisted: true }
  }
  const repo = createLocalProjectRecord({
    path: resolvedPath,
    displayName: displayName?.trim() || getRepoName(resolvedPath),
    kind: repoKind,
    detected
  })

  store.addRepo(repo)
  await prepareLocalWorktreeRootForRepo(store, repo)
  return { repo, alreadyExisted: false }
}
