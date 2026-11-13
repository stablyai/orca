import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RepoHostTarget } from '../../../shared/repo-host-identity'
import {
  getRepoHostIdentity,
  getRepoHostIdentityForParts
} from '../../../shared/repo-host-identity'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { resolveProjectExecutionRuntime } from '../../../shared/execution-host/project-execution-runtime'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { createRepoRowExecutionHostLookup } from '../../../shared/execution-host/worktree-execution-host-resolution'

type ObservationState = Pick<
  PersistedState,
  'repos' | 'worktreeMeta' | 'worktreeMetaByIdentity' | 'worktreeIdentityAliases'
>

/** Retire facts, never the workspace or its aliases, when an addressed locator changes meaning. */
export function retireGitWorktreeObservations(
  state: ObservationState,
  repos: readonly RepoHostTarget[],
  setups: readonly Pick<ProjectHostSetup, 'id' | 'hostId'>[] = []
): boolean {
  if (repos.length === 0 && setups.length === 0) {
    return false
  }
  const repoKeys = new Set(repos.map(getRepoHostIdentity))
  const setupIdsByHost = new Map<ExecutionHostId, Set<string>>()
  for (const setup of setups) {
    const ids = setupIdsByHost.get(setup.hostId) ?? new Set<string>()
    ids.add(setup.id)
    setupIdsByHost.set(setup.hostId, ids)
  }
  const repoLookup = createRepoRowExecutionHostLookup(state.repos)
  const matchesRepo = (id: string, hostId: ExecutionHostId | undefined): boolean =>
    hostId !== undefined &&
    repoKeys.has(getRepoHostIdentityForParts(getRepoIdFromWorktreeId(id), hostId))
  const matchesSetup = (meta: WorktreeMeta): boolean =>
    !!meta.hostId &&
    !!meta.projectHostSetupId &&
    !!setupIdsByHost.get(meta.hostId)?.has(meta.projectHostSetupId)
  const identities = new Set<string>()
  for (const [alias, keys] of Object.entries(state.worktreeIdentityAliases ?? {})) {
    if (
      matchesRepo(
        getWorktreeIdFromHostIdentity(alias),
        getExecutionHostIdFromWorktreeHostIdentity(alias)
      )
    ) {
      for (const key of keys) {
        identities.add(key)
      }
    }
  }
  let changed = false
  const retire = (meta: WorktreeMeta): void => {
    if (Object.hasOwn(meta, 'gitWorktree')) {
      delete meta.gitWorktree
      changed = true
    }
  }
  for (const [key, meta] of Object.entries(state.worktreeMetaByIdentity ?? {})) {
    if (identities.has(key) || matchesSetup(meta)) {
      retire(meta)
    }
  }
  for (const [id, meta] of Object.entries(state.worktreeMeta)) {
    const owner = repoLookup.byId(getRepoIdFromWorktreeId(id))
    const hostId =
      meta.hostId ?? (owner.kind === 'resolved' ? getRepoExecutionHostId(owner.owner) : undefined)
    if (matchesRepo(id, hostId) || matchesSetup(meta)) {
      retire(meta)
    }
  }
  return changed
}

function configuredRuntimeKey(
  project: Project,
  defaultRuntime: GlobalSettings['localWindowsRuntimeDefault']
): string {
  // Availability changes do not change which execution space the saved preference denotes.
  const resolution = resolveProjectExecutionRuntime({
    appPlatform: process.platform,
    projectId: project.id,
    projectRuntimePreference: project.localWindowsRuntimePreference,
    globalWindowsRuntimeDefault: defaultRuntime
  })
  return resolution.status === 'resolved' ? resolution.runtime.cacheKey : resolution.repair.cacheKey
}

export function retireChangedProjectRuntimeObservations(
  state: PersistedState,
  previousProjects: readonly Project[],
  previousDefault: GlobalSettings['localWindowsRuntimeDefault']
): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  const currentProjects = new Map(state.projects.map((project) => [project.id, project]))
  const changedProjects = new Set<string>()
  const changedRepoIds = new Set<string>()
  for (const previous of previousProjects) {
    const current = currentProjects.get(previous.id)
    if (
      current &&
      configuredRuntimeKey(previous, previousDefault) !==
        configuredRuntimeKey(current, state.settings.localWindowsRuntimeDefault)
    ) {
      changedProjects.add(current.id)
      for (const id of current.sourceRepoIds) {
        changedRepoIds.add(id)
      }
    }
  }
  return retireGitWorktreeObservations(
    state,
    state.repos.filter(
      (repo) => getRepoExecutionHostId(repo) === 'local' && changedRepoIds.has(repo.id)
    ),
    state.projectHostSetups.filter(
      (setup) => setup.hostId === 'local' && changedProjects.has(setup.projectId)
    )
  )
}
