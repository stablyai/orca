import type { Store } from './persistence'
import type { Repo } from '../shared/types'
import {
  resolveProjectExecutionRuntime,
  type ProjectExecutionRuntimeResolution
} from '../shared/project-execution-runtime'
import {
  getCachedWslAvailability,
  getCachedWslDistros,
  hasCachedWslAvailability,
  hasCachedWslDistros
} from './wsl'
import { getRepoIdFromWorktreeId } from '../shared/worktree-id'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'

function canResolveProjectRuntimeForRepo(store: Store): boolean {
  return typeof store.getProjects === 'function' && typeof store.getSettings === 'function'
}

function canResolveProjectRuntimeForWorktreeId(store: Store): boolean {
  return canResolveProjectRuntimeForRepo(store) && typeof store.getRepo === 'function'
}

export function resolveLocalProjectRuntimeForRepo(
  store: Store,
  repo: Repo
): ProjectExecutionRuntimeResolution | undefined {
  if (
    getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID ||
    !canResolveProjectRuntimeForRepo(store)
  ) {
    return undefined
  }
  const project = store.getProjects().find((entry) => entry.sourceRepoIds.includes(repo.id))
  if (!project) {
    return undefined
  }
  const wslAvailable = hasCachedWslAvailability()
    ? (getCachedWslAvailability() ?? undefined)
    : undefined
  const availableWslDistros = hasCachedWslDistros() ? getCachedWslDistros() : null
  return resolveProjectExecutionRuntime({
    appPlatform: process.platform,
    projectId: project.id,
    projectRuntimePreference: project.localWindowsRuntimePreference,
    globalWindowsRuntimeDefault: store.getSettings().localWindowsRuntimeDefault,
    wslAvailable,
    availableWslDistros
  })
}

export function resolveLocalProjectRuntimeForWorktreeId(
  store: Store | undefined,
  worktreeId: string | undefined
): ProjectExecutionRuntimeResolution | undefined {
  if (!store || !worktreeId) {
    return undefined
  }
  if (!canResolveProjectRuntimeForWorktreeId(store)) {
    return undefined
  }
  const repo = store.getRepo(getRepoIdFromWorktreeId(worktreeId))
  return repo ? resolveLocalProjectRuntimeForRepo(store, repo) : undefined
}
