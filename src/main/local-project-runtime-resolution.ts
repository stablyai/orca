import type { Store } from './persistence'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { Project } from '../shared/project-types'
import type { Repo } from '../shared/repo-types'
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
import { getRepoIdFromWorktreeId } from '../shared/worktree/id'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'

/**
 * The slice of the store runtime resolution actually reads. Structural rather
 * than the full `Store` so narrowed stores -- the Orca runtime's `RuntimeStore`,
 * worktree root preparation -- resolve the same runtime the create path does
 * instead of silently falling back to host placement.
 *
 * Members stay optional because those stores declare them optional; the
 * `typeof` guards below are what actually decide whether resolution can run.
 */
export type ProjectRuntimeResolutionStore = {
  getProjects?: Store['getProjects']
  getRepo?: Store['getRepo']
  getSettings?: () => Partial<Pick<GlobalSettings, 'localWindowsRuntimeDefault'>>
}

type ResolvableStore = ProjectRuntimeResolutionStore & {
  getProjects: NonNullable<ProjectRuntimeResolutionStore['getProjects']>
  getSettings: NonNullable<ProjectRuntimeResolutionStore['getSettings']>
}

function canResolveProjectRuntimeForRepo(
  store: ProjectRuntimeResolutionStore
): store is ResolvableStore {
  return typeof store.getProjects === 'function' && typeof store.getSettings === 'function'
}

function canResolveProjectRuntimeForWorktreeId(
  store: ProjectRuntimeResolutionStore
): store is ResolvableStore & { getRepo: NonNullable<ProjectRuntimeResolutionStore['getRepo']> } {
  return canResolveProjectRuntimeForRepo(store) && typeof store.getRepo === 'function'
}

function resolveLocalProjectRuntime(
  store: ResolvableStore,
  project: Project,
  settings: ReturnType<ResolvableStore['getSettings']> = store.getSettings()
): ProjectExecutionRuntimeResolution {
  const wslAvailable = hasCachedWslAvailability()
    ? (getCachedWslAvailability() ?? undefined)
    : undefined
  const availableWslDistros = hasCachedWslDistros() ? getCachedWslDistros() : null
  return resolveProjectExecutionRuntime({
    appPlatform: process.platform,
    projectId: project.id,
    projectRuntimePreference: project.localWindowsRuntimePreference,
    globalWindowsRuntimeDefault: settings.localWindowsRuntimeDefault,
    wslAvailable,
    availableWslDistros
  })
}

export function resolveLocalProjectRuntimeForRepo(
  store: ProjectRuntimeResolutionStore,
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
  return resolveLocalProjectRuntime(store, project)
}

export function resolveLocalProjectRuntimesForRepos(
  store: ProjectRuntimeResolutionStore,
  repos: readonly Repo[]
): ReadonlyMap<string, ProjectExecutionRuntimeResolution> {
  const runtimeByRepoId = new Map<string, ProjectExecutionRuntimeResolution>()
  if (!canResolveProjectRuntimeForRepo(store)) {
    return runtimeByRepoId
  }
  const requestedRepoIds = new Set(
    repos
      .filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
      .map((repo) => repo.id)
  )
  if (requestedRepoIds.size === 0) {
    return runtimeByRepoId
  }
  const settings = store.getSettings()
  for (const project of store.getProjects()) {
    const matchingRepoIds = project.sourceRepoIds.filter(
      (repoId) => requestedRepoIds.has(repoId) && !runtimeByRepoId.has(repoId)
    )
    if (matchingRepoIds.length === 0) {
      continue
    }
    // Why: one project runtime applies to every source repo in that project;
    // resolving it once prevents mobile polls from rescanning project settings.
    const runtime = resolveLocalProjectRuntime(store, project, settings)
    for (const repoId of matchingRepoIds) {
      runtimeByRepoId.set(repoId, runtime)
    }
  }
  return runtimeByRepoId
}

export function resolveLocalProjectRuntimeForWorktreeId(
  store: ProjectRuntimeResolutionStore | undefined,
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
