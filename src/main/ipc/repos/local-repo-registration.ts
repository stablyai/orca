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
import { describeWslUncAccessDenied } from '../../wsl/wsl-unc-access-denied'

type RegistrationResult = { repo: Repo; alreadyExisted: boolean } | { error: string }
type Registration = { promise: Promise<RegistrationResult>; repoId?: string }
const registrations = new WeakMap<Store, Map<string, Registration>>()

export async function addLocalRepoFromPath(
  store: Store,
  path: string,
  kind: 'git' | 'folder' = 'git',
  displayName?: string
): Promise<RegistrationResult> {
  const canonical = normalizeRuntimePathForComparison(await realpath(path).catch(() => path))
  let pending = registrations.get(store)
  if (!pending) {
    pending = new Map()
    registrations.set(store, pending)
  }
  let registration = pending.get(canonical)
  if (
    registration?.repoId &&
    !store
      .getRepos()
      .some(
        (repo) =>
          repo.id === registration?.repoId &&
          getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      )
  ) {
    pending.delete(canonical)
    registration = undefined
  }
  const joined = Boolean(registration)
  if (!registration) {
    const entry: Registration = { promise: Promise.resolve({ error: 'Registration not started' }) }
    entry.promise = registerLocalRepoFromPath(store, path, kind, displayName, (repoId) => {
      entry.repoId = repoId
    })
    registration = entry
    pending.set(canonical, entry)
  }
  const currentResult = (result: RegistrationResult): RegistrationResult => {
    if ('error' in result) {
      return result
    }
    const current = store
      .getRepos()
      .find(
        (repo) =>
          repo.id === result.repo.id && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      )
    return current
      ? { ...result, repo: current }
      : { error: 'The project was removed while it was being added.' }
  }
  try {
    const result = await registration.promise
    const current = currentResult(result)
    if (!joined || ('repo' in result && 'error' in current)) {
      return current
    }
    const own = await registerLocalRepoFromPath(store, path, kind, displayName, undefined, () => {
      const checked = currentResult(result)
      if ('repo' in result && 'error' in checked) {
        return Promise.resolve(checked)
      }
      if (pending.get(canonical) === registration) {
        pending.delete(canonical)
      }
      return addLocalRepoFromPath(store, path, kind, displayName)
    })
    const settled = currentResult(result)
    return 'repo' in result && 'error' in settled ? settled : currentResult(own)
  } finally {
    if (pending.get(canonical) === registration) {
      pending.delete(canonical)
    }
  }
}

async function registerLocalRepoFromPath(
  store: Store,
  path: string,
  kind: 'git' | 'folder' = 'git',
  displayName?: string,
  registered?: (repoId: string) => void,
  registerMissing?: () => Promise<RegistrationResult>
): Promise<{ repo: Repo; alreadyExisted: boolean } | { error: string }> {
  const repoKind = kind === 'folder' ? 'folder' : 'git'
  if (repoKind === 'git') {
    await awaitWindowsHostGitEnvironmentReady({ cwd: path })
  }
  const gitInfo = repoKind === 'git' ? await inspectGitRepoForRegistrationAsync(path) : null
  if (gitInfo && !gitInfo.isRepo) {
    return {
      error: (await describeWslUncAccessDenied(path)) ?? `Not a valid git repository: ${path}`
    }
  }

  const resolvedPath = gitInfo?.rootPath ?? path
  const pathKey = normalizeRuntimePathForComparison(path)
  const existing = store
    .getRepos()
    .find(
      (repo) =>
        getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
        normalizeRuntimePathForComparison(repo.path) === pathKey
    )
  if (existing) {
    return { repo: existing, alreadyExisted: true }
  }

  const resolvedPathKey = normalizeRuntimePathForComparison(resolvedPath)
  if (resolvedPathKey !== pathKey) {
    const existingAfterRootResolve = store
      .getRepos()
      .find(
        (repo) =>
          getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
          normalizeRuntimePathForComparison(repo.path) === resolvedPathKey
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
            getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
            !isFolderRepo(repo) &&
            normalizeRuntimePathForComparison(repo.path) === mainRepoKey
        )
      if (trackedMainRepo) {
        return { repo: trackedMainRepo, alreadyExisted: true }
      }
    }
  }

  if (registerMissing) {
    return registerMissing()
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
  registered?.(repo.id)
  await prepareLocalWorktreeRootForRepo(store, repo)
  return { repo, alreadyExisted: false }
}
