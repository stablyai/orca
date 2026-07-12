import type { Store } from './persistence'
import type { Project, Repo } from '../shared/types'
import {
  normalizeProjectDefaultShell,
  type ProjectDefaultShell
} from '../shared/project-default-shell'
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

function findProjectForRepo(store: Store, repo: Repo): Project | undefined {
  return store.getProjects().find((entry) => entry.sourceRepoIds.includes(repo.id))
}

/**
 * Resolve a local repo's project execution runtime (windows-host vs. WSL distro),
 * using cached WSL probes rather than re-invoking wsl.exe on this hot path.
 */
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
  const project = findProjectForRepo(store, repo)
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

/** {@link resolveLocalProjectRuntimeForRepo}, looked up from a worktree id via its owning repo. */
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

/** Terminal default-shell axis (T2's Project.defaultShell) for a worktree's project. */
export function resolveLocalProjectDefaultShellForWorktreeId(
  store: Store | undefined,
  worktreeId: string | undefined
): ProjectDefaultShell | undefined {
  if (!store || !worktreeId || !canResolveProjectRuntimeForWorktreeId(store)) {
    return undefined
  }
  const repo = store.getRepo(getRepoIdFromWorktreeId(worktreeId))
  if (!repo || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    return undefined
  }
  const defaultShell = findProjectForRepo(store, repo)?.defaultShell
  // Why: persist load is a JSON cast, so a legacy/hand-edited bad value can reach
  // here unnormalized (the write path normalizes). Preserve "no override" as
  // undefined, but coerce any present-but-invalid value the same way writes do.
  return defaultShell === undefined ? undefined : normalizeProjectDefaultShell(defaultShell)
}
