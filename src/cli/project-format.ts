import type {
  Project,
  ProjectGroup,
  ProjectHostSetup,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateResult,
  Repo
} from '../shared/types'

export function formatProjectList(result: { projects: Project[] }): string {
  if (result.projects.length === 0) {
    return 'No projects found.'
  }
  return result.projects
    .map((project) => {
      const identity = project.providerIdentity
        ? `${project.providerIdentity.provider}:${project.providerIdentity.owner}/${project.providerIdentity.repo}`
        : 'no-provider'
      return `${project.id}  ${project.displayName}  ${identity}`
    })
    .join('\n')
}

export function formatProjectHostSetupList(result: { setups: ProjectHostSetup[] }): string {
  if (result.setups.length === 0) {
    return 'No project host setups found.'
  }
  return result.setups
    .map(
      (setup) =>
        `${setup.id}  project:${setup.projectId}  host:${setup.hostId}  ${setup.setupState}  ${setup.path}`
    )
    .join('\n')
}

export function formatProjectHostSetupResult(result: { result: ProjectHostSetupResult }): string {
  const { project, setup, repo } = result.result
  return formatProjectHostSetupResultFields(project, setup, repo.id)
}

export function formatProjectHostSetupCreateResult(result: {
  result: ProjectHostSetupCreateResult
}): string {
  const { project, setup } = result.result
  return formatProjectHostSetupResultFields(project, setup, undefined)
}

export function formatProjectHostSetupUpdateResult(result: {
  result: ProjectHostSetupUpdateResult
}): string {
  const { project, setup, repo } = result.result
  return formatProjectHostSetupResultFields(project, setup, repo?.id)
}

export function formatProjectHostSetupDeleteResult(result: {
  result: ProjectHostSetupDeleteResult
}): string {
  const { project, setup, repo } = result.result
  return [
    `deleted: ${setup.id}`,
    formatProjectHostSetupResultFields(project, setup, repo?.id)
  ].join('\n')
}

function formatProjectHostSetupResultFields(
  project: Project,
  setup: ProjectHostSetup,
  repoId: string | undefined
): string {
  return [
    `projectId: ${project.id}`,
    `project: ${project.displayName}`,
    `setupId: ${setup.id}`,
    `hostId: ${setup.hostId}`,
    `path: ${setup.path}`,
    `state: ${setup.setupState}`,
    `method: ${setup.setupMethod}`,
    `repoId: ${repoId ?? 'none'}`
  ].join('\n')
}

/** Render the `project group list` result as one line per group. */
export function formatProjectGroupList(result: { groups: ProjectGroup[] }): string {
  if (result.groups.length === 0) {
    return 'No project groups found.'
  }
  return result.groups.map(formatProjectGroupLine).join('\n')
}

/** Render the group returned by `project group create`. */
export function formatProjectGroupCreateResult(result: { group: ProjectGroup }): string {
  return formatProjectGroupLine(result.group)
}

/** Render the outcome of `project group add` (the moved repo and its group). */
export function formatProjectGroupAddResult(result: { repo: Repo }): string {
  // Why: moveProjectToGroup silently ungroups when the group id does not exist,
  // so surface the repo's actual resulting group rather than the requested one.
  return `repo: ${result.repo.id}  group:${result.repo.projectGroupId ?? 'none'}`
}

/** Render whether `project group rm` deleted a group. */
export function formatProjectGroupDeleteResult(result: { deleted: boolean }): string {
  return result.deleted ? 'deleted' : 'not found'
}

function formatProjectGroupLine(group: ProjectGroup): string {
  return `${group.id}  ${group.name}  parent:${group.parentPath ?? 'none'}`
}
