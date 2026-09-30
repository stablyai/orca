import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { carryProjectStateThroughIdentityChange } from '../../../shared/project-identity-succession'

export function projectHostSetupCompatibilityStateEqual(
  state: Pick<PersistedState, 'projects' | 'projectHostSetups'>,
  nextState: Pick<PersistedState, 'projects' | 'projectHostSetups'>
): boolean {
  return (
    arraysEqualByJson(state.projects ?? [], nextState.projects ?? []) &&
    arraysEqualByJson(state.projectHostSetups ?? [], nextState.projectHostSetups ?? [])
  )
}

// Why element-wise: a whole-array JSON.stringify re-serialises every row to answer a
// question that a shared identity already settles for most of them.
function arraysEqualByJson<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) {
    return true
  }
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) {
      continue
    }
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
      return false
    }
  }
  return true
}

export function isRepoBackedProjectHostSetup(
  setup: ProjectHostSetup,
  currentRepoIds: ReadonlySet<string>
): boolean {
  const repoId = typeof setup.repoId === 'string' ? setup.repoId : ''
  return repoId.length > 0 && (currentRepoIds.has(repoId) || setup.id === repoId)
}

function projectHostKey(setup: Pick<ProjectHostSetup, 'projectId' | 'hostId'>): string {
  return `${setup.projectId}\u0000${setup.hostId}`
}

export function mergeProjectHostSetupCompatibilityState(
  state: Pick<PersistedState, 'projects' | 'projectHostSetups'>,
  repos: readonly Repo[]
): Pick<PersistedState, 'projects' | 'projectHostSetups'> {
  const projection = projectHostSetupProjectionFromRepos(repos)
  const succession = carryProjectStateThroughIdentityChange(
    projection.projects,
    state.projects ?? []
  )
  const currentRepoIds = new Set(repos.map((repo) => repo.id))
  const projectedProjectIds = new Set(projection.projects.map((project) => project.id))
  const projectedSetupIds = new Set(projection.setups.map((setup) => setup.id))
  const projectedHosts = new Set(projection.setups.map(projectHostKey))
  // Why: legacy/repo-backed setup rows reuse the repo id; keep only independent rows so repo deletion leaves no ghosts.
  const independentSetups = (state.projectHostSetups ?? [])
    .filter((setup) => {
      if (projectedSetupIds.has(setup.id)) {
        return false
      }
      return !isRepoBackedProjectHostSetup(setup, currentRepoIds)
    })
    // Why: follow the repo's project through a derived-id change so no ghost project row survives.
    .map((setup) => {
      const remappedProjectId = succession.remappedProjectIds.get(setup.projectId)
      return remappedProjectId ? { ...setup, projectId: remappedProjectId } : setup
    })
    // Why: a project resolves to one setup per host. Once a repo projection covers that
    // pair, a leftover placeholder is a ghost that shadows the ready row — it sorts first
    // and reads back as "not set up". Runs after the remap so renamed rows are caught too.
    .filter((setup) => !projectedHosts.has(projectHostKey(setup)))
  const independentProjectIds = new Set(independentSetups.map((setup) => setup.projectId))
  const independentProjects = (state.projects ?? [])
    .filter(
      (project) => independentProjectIds.has(project.id) && !projectedProjectIds.has(project.id)
    )
    .map((project) => ({
      ...project,
      sourceRepoIds: project.sourceRepoIds.filter((repoId) => currentRepoIds.has(repoId))
    }))
  return {
    projects: [...succession.projects, ...independentProjects],
    projectHostSetups: [...projection.setups, ...independentSetups]
  }
}

export function makeProjectHostSetupId(
  projectId: string,
  hostId: ExecutionHostId,
  existingIds: ReadonlySet<string>,
  requestedId?: string
): string {
  const baseId = requestedId?.trim() || `${projectId}::${hostId}`
  if (!existingIds.has(baseId)) {
    return baseId
  }
  let suffix = 2
  let candidate = `${baseId}::${suffix}`
  while (existingIds.has(candidate)) {
    suffix++
    candidate = `${baseId}::${suffix}`
  }
  return candidate
}
