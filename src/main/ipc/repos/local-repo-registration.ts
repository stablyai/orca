import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../shared/constants'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { awaitWindowsHostGitEnvironmentReady } from '../../git/runner'
import {
  inspectGitRepoForRegistrationAsync,
  getGitRepoRootAsync,
  getRepoName
} from '../../git/repo'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { findProjectAtSameRealPath } from '../../project-realpath-identity'
import { detectRepoIconAndUpstream } from '../../repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
import { runKeyedSerializedOperation } from '../../cli/keyed-promise-queue'
import { describeWslUncAccessDenied } from '../../wsl/wsl-unc-access-denied'

type RegistrationResult = { repo: Repo; alreadyExisted: boolean } | { error: string }
const registrations = new WeakMap<Store, Map<string, Promise<void>>>()

export async function addLocalRepoFromPath(
  store: Store,
  path: string,
  kind: 'git' | 'folder' = 'git',
  displayName?: string
): Promise<RegistrationResult> {
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
  const resolvedPathKey = normalizeRuntimePathForComparison(resolvedPath)
  const canonical = normalizeRuntimePathForComparison(
    await realpath(resolvedPath).catch(() => resolvedPath)
  )
  const localRepos = (): Repo[] =>
    store.getRepos().filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
  const currentResult = (result: RegistrationResult): RegistrationResult => {
    if ('error' in result) {
      return result
    }
    const current = localRepos().find((repo) => repo.id === result.repo.id)
    return current
      ? { ...result, repo: current }
      : { error: 'The project was removed while it was being added.' }
  }
  let mainRepoKey: string | null = null
  const lookup = async (): Promise<Repo | null> => {
    const existing = localRepos().find(
      (repo) => normalizeRuntimePathForComparison(repo.path) === pathKey
    )
    if (existing) {
      return existing
    }
    const root = localRepos().find(
      (repo) => normalizeRuntimePathForComparison(repo.path) === resolvedPathKey
    )
    if (root) {
      return root
    }
    const physical = await findProjectAtSameRealPath(localRepos(), resolvedPath, canonical)
    if (physical) {
      return physical
    }
    // Linked checkouts reuse a tracked Git main, but create at their own root if it is absent.
    const mainRoot = gitInfo?.mainRepoPath ? await getGitRepoRootAsync(gitInfo.mainRepoPath) : null
    mainRepoKey = mainRoot ? normalizeRuntimePathForComparison(mainRoot) : null
    return (
      localRepos().find(
        (repo) =>
          !isFolderRepo(repo) && normalizeRuntimePathForComparison(repo.path) === mainRepoKey
      ) ?? null
    )
  }
  const existing = await lookup()
  if (existing) {
    return currentResult({ repo: existing, alreadyExisted: true })
  }
  let pending = registrations.get(store)
  if (!pending) {
    pending = new Map()
    registrations.set(store, pending)
  }
  const result = await runKeyedSerializedOperation(
    pending,
    canonical,
    async (): Promise<RegistrationResult> => {
      const existing = await lookup()
      if (existing) {
        return currentResult({ repo: existing, alreadyExisted: true })
      }
      const detected = await detectRepoIconAndUpstream({
        repoPath: resolvedPath,
        kind: repoKind,
        executionHostId: LOCAL_EXECUTION_HOST_ID
      })
      // Another registration can finish while icon discovery is pending.
      const raceWinner = store.getRepos().find((repo) => {
        if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
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
              // Explicit imports are ready host setups; legacy-repo is reserved for migrated records.
              projectHostSetupMethod: 'imported-existing-folder' as const
            }
          : {})
      }

      store.addRepo(repo)
      return { repo, alreadyExisted: false }
    }
  )
  if ('repo' in result && !result.alreadyExisted) {
    await prepareLocalWorktreeRootForRepo(store, result.repo)
  }
  return currentResult(result)
}
