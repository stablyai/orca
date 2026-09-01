import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import {
  resolveLocalProjectRuntimeForRepo,
  type ProjectRuntimeResolutionStore
} from './local-project-runtime-resolution'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'

export {
  resolveLocalProjectRuntimeForRepo,
  resolveLocalProjectRuntimesForRepos
} from './local-project-runtime-resolution'

export type LocalProjectGitExecOptions = {
  cwd: string
  wslDistro?: string
}

export type LocalProjectWorktreeGitOptions = {
  wslDistro?: string
}

export function getLocalProjectGitExecOptions(
  store: Store,
  repo: Repo
): LocalProjectGitExecOptions {
  // Why: local git must run in the same resolved project runtime as agents,
  // terminals, and preflight; repair states must not silently fall back to host git.
  return getLocalProjectGitExecOptionsForRuntime(
    repo,
    resolveLocalProjectRuntimeForRepo(store, repo)
  )
}

function getLocalProjectGitExecOptionsForRuntime(
  repo: Repo,
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): LocalProjectGitExecOptions {
  if (!projectRuntime) {
    return { cwd: repo.path }
  }
  if (projectRuntime.status === 'repair-required') {
    throw new Error(
      `Project runtime requires repair before git execution: ${projectRuntime.repair.reason}`
    )
  }
  if (projectRuntime.runtime.kind === 'wsl') {
    return { cwd: repo.path, wslDistro: projectRuntime.runtime.distro }
  }
  return { cwd: repo.path }
}

export function getLocalProjectWorktreeGitOptions(
  store: Store,
  repo: Repo
): LocalProjectWorktreeGitOptions {
  const { wslDistro } = getLocalProjectGitExecOptions(store, repo)
  return wslDistro ? { wslDistro } : {}
}

/**
 * Git routing for the speculative worktree-create warm-up.
 *
 * Deliberately non-throwing where `getLocalProjectWorktreeGitOptions` throws: an
 * optimistic prefetch must not report a repair-required runtime as a failure, so
 * an unresolved runtime falls back to the host Git the warm-up used before
 * routing existed.
 */
export function getWorktreeCreatePrefetchGitOptions(
  store: Store,
  repo: Repo
): LocalProjectWorktreeGitOptions {
  if (isFolderRepo(repo)) {
    return {}
  }
  const projectRuntime = resolveLocalProjectRuntimeForRepo(store, repo)
  if (!projectRuntime || projectRuntime.status !== 'resolved') {
    return {}
  }
  return getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime)
}

export function getLocalProjectWorktreeGitOptionsForRuntime(
  repo: Repo,
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): LocalProjectWorktreeGitOptions {
  // Why: callers that already batch-resolved project runtimes must not rescan
  // every project once per repo on a polling path.
  const { wslDistro } = getLocalProjectGitExecOptionsForRuntime(repo, projectRuntime)
  return wslDistro ? { wslDistro } : {}
}

/**
 * Distro whose filesystem this repo's worktrees belong on, or undefined.
 *
 * Deliberately non-throwing where `getLocalProjectGitExecOptions` throws: a
 * runtime that needs repair must not block creating a worktree, it just falls
 * back to the Windows-side placement that has always been used.
 */
export function getWorktreeMirrorDistro(
  store: ProjectRuntimeResolutionStore,
  repo: Repo
): string | undefined {
  const projectRuntime = resolveLocalProjectRuntimeForRepo(store, repo)
  if (!projectRuntime || projectRuntime.status !== 'resolved') {
    return undefined
  }
  return projectRuntime.runtime.kind === 'wsl' ? projectRuntime.runtime.distro : undefined
}
