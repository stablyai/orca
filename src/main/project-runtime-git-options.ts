import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import {
  resolveLocalProjectRuntimeForRepo,
  type ProjectRuntimeResolutionStore
} from './local-project-runtime-resolution'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'
import { wslHostsGateOpen } from './wsl/wsl-host-gate'

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

export type LocalProjectGhExecOptions = LocalProjectWorktreeGitOptions & {
  ghAccount?: Repo['ghAccount']
}

export function getLocalProjectGitExecOptions(
  store: ProjectRuntimeResolutionStore,
  repo: Repo
): LocalProjectGitExecOptions {
  // Keep Git aligned with agent/terminal runtimes; repair states must not silently select host Git.
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
  if (projectRuntime.runtime.kind === 'wsl' && projectRuntime.runtime.git !== 'windows-host') {
    return { cwd: repo.path, wslDistro: projectRuntime.runtime.distro }
  }
  return { cwd: repo.path }
}

export function getLocalProjectWorktreeGitOptions(
  store: ProjectRuntimeResolutionStore,
  repo: Repo
): LocalProjectWorktreeGitOptions {
  const { wslDistro } = getLocalProjectGitExecOptions(store, repo)
  return wslDistro ? { wslDistro } : {}
}

/** Include the repo’s gh account binding; worktree Git options alone use the ambient login. */
export function getLocalProjectGhExecOptions(
  store: ProjectRuntimeResolutionStore,
  repo: Repo
): LocalProjectGhExecOptions {
  return {
    ...getLocalProjectWorktreeGitOptions(store, repo),
    ...(repo.ghAccount ? { ghAccount: repo.ghAccount } : {})
  }
}

/** Speculative prefetch falls back to host Git for unresolved runtimes instead of raising a repair error. */
export function getWorktreeCreatePrefetchGitOptions(
  store: ProjectRuntimeResolutionStore,
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

/** Base-ref and remote-identity reads follow the runtime only with WSL hosts on; before, host Git. */
export function getProjectRuntimeReadGitOptions(
  store: ProjectRuntimeResolutionStore,
  repo: Repo
): LocalProjectWorktreeGitOptions {
  return wslHostsGateOpen() ? getWorktreeCreatePrefetchGitOptions(store, repo) : {}
}

export function getLocalProjectWorktreeGitOptionsForRuntime(
  repo: Repo,
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): LocalProjectWorktreeGitOptions {
  // Reuse batch-resolved runtimes to avoid rescanning projects per repo during polls.
  const { wslDistro } = getLocalProjectGitExecOptionsForRuntime(repo, projectRuntime)
  return wslDistro ? { wslDistro } : {}
}

/** Unresolved runtimes retain Windows-side worktree placement instead of blocking creation. */
export function getWorktreeMirrorDistro(
  store: ProjectRuntimeResolutionStore,
  repo: Repo
): string | undefined {
  return getWorktreeMirrorDistroForRuntime(resolveLocalProjectRuntimeForRepo(store, repo))
}

export function getWorktreeMirrorDistroForRuntime(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): string | undefined {
  if (!projectRuntime || projectRuntime.status !== 'resolved') {
    return undefined
  }
  // Windows Git can't use a worktree WSL Git would create inside the distro.
  return projectRuntime.runtime.kind === 'wsl' && projectRuntime.runtime.git !== 'windows-host'
    ? projectRuntime.runtime.distro
    : undefined
}
