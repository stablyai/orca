import { randomUUID } from 'node:crypto'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../shared/constants'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { awaitWindowsHostGitEnvironmentReady } from '../../git/runner'
import { inspectGitRepoForRegistration, getGitRepoRoot, getRepoName } from '../../git/repo'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { detectRepoIconAndUpstream } from '../../repo-icon-autodetect'
import { getLocalGitRepoAccessBlocker } from '../../git/git-safe-directory'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'

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
  const gitInfo = repoKind === 'git' ? inspectGitRepoForRegistration(path) : null
  if (gitInfo && !gitInfo.isRepo) {
    return { error: `Not a valid git repository: ${path}` }
  }

  const resolvedPath = gitInfo?.rootPath ?? path
  const pathKey = normalizeRuntimePathForComparison(path)

  const blockIfGitInaccessible = async (repoPath: string): Promise<{ error: string } | null> => {
    // Why: isGitRepo may accept a .git marker after rev-parse fails for ownership; without this
    // probe we persist or re-surface kind:git with zero worktrees and no remediation (#12627).
    if (repoKind !== 'git') {
      return null
    }
    const accessBlocker = await getLocalGitRepoAccessBlocker(repoPath)
    return accessBlocker ? { error: accessBlocker } : null
  }

  const existing = store
    .getRepos()
    .find((repo) => !repo.connectionId && normalizeRuntimePathForComparison(repo.path) === pathKey)
  if (existing) {
    // Why: re-add of a pre-fix empty record must surface safe.directory, not silently "succeed".
    const blocked = await blockIfGitInaccessible(existing.path)
    if (blocked) {
      return blocked
    }
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
      const blocked = await blockIfGitInaccessible(existingAfterRootResolve.path)
      if (blocked) {
        return blocked
      }
      return { repo: existingAfterRootResolve, alreadyExisted: true }
    }
  }

  // Why: a linked worktree reports itself as its own toplevel, so the path checks above can't see that
  // it belongs to an already-tracked repo. Adding it anyway yields a second "ready" host setup on the
  // same project and host — a duplicate run-target row that resolves to a transient worktree path.
  let mainRepoKey: string | null = null
  if (repoKind === 'git') {
    const mainRepoRoot = gitInfo?.mainRepoPath ? getGitRepoRoot(gitInfo.mainRepoPath) : null
    if (mainRepoRoot) {
      mainRepoKey = normalizeRuntimePathForComparison(mainRepoRoot)
      // Why !isFolderRepo: only a git-kind main checkout projects onto the same project as its
      // worktree, so matching a folder record would suppress the add without deduping anything.
      const trackedMainRepo = store
        .getRepos()
        .find(
          (repo) =>
            !repo.connectionId &&
            !isFolderRepo(repo) &&
            normalizeRuntimePathForComparison(repo.path) === mainRepoKey
        )
      if (trackedMainRepo) {
        const blocked = await blockIfGitInaccessible(trackedMainRepo.path)
        if (blocked) {
          return blocked
        }
        return { repo: trackedMainRepo, alreadyExisted: true }
      }
    }
    const blocked = await blockIfGitInaccessible(resolvedPath)
    if (blocked) {
      return blocked
    }
  }

  const detected = await detectRepoIconAndUpstream({
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
  const repo: Repo = {
    id: randomUUID(),
    path: resolvedPath,
    displayName: displayName?.trim() || getRepoName(resolvedPath),
    badgeColor: DEFAULT_REPO_BADGE_COLOR,
    ...detected,
    addedAt: Date.now(),
    kind: repoKind,
    ...(repoKind === 'git'
      ? {
          externalWorktreeVisibilityLegacy: false,
          // Why: new Add Project imports are explicit ready host setups; 'legacy-repo' is reserved for older records/projection.
          projectHostSetupMethod: 'imported-existing-folder' as const
        }
      : {})
  }

  store.addRepo(repo)
  await prepareLocalWorktreeRootForRepo(store, repo)
  return { repo, alreadyExisted: false }
}
