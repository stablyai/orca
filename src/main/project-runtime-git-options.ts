import type { Store } from './persistence'
import type { Repo } from '../shared/types'
import { resolveLocalProjectRuntimeForRepo } from './local-project-runtime-resolution'

export { resolveLocalProjectRuntimeForRepo } from './local-project-runtime-resolution'

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
  const projectRuntime = resolveLocalProjectRuntimeForRepo(store, repo)
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
