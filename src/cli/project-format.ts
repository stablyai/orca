import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateResult
} from '../shared/project-types'
import type { ProjectGroup } from '../shared/project-group-types'
import type { Repo } from '../shared/repo-types'

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

export type ProjectGroupListEntry = ProjectGroup & {
  repos: { id: string; displayName: string }[]
}

export function formatProjectGroupList(result: { groups: ProjectGroupListEntry[] }): string {
  if (result.groups.length === 0) {
    return 'No project groups found.'
  }
  return result.groups
    .map((group) => {
      const repos = group.repos.map((repo) => repo.displayName).join(', ') || 'none'
      return `${formatProjectGroup(group)}  order:${group.tabOrder}  projects:${repos}`
    })
    .join('\n')
}

export function formatProjectGroup(group: ProjectGroup): string {
  return `${group.id}  ${group.name}  parent:${group.parentGroupId ?? 'none'}`
}

export function formatProjectGroupMembership(result: { repo: Repo }): string {
  return `${result.repo.displayName}  repo:${result.repo.id}  group:${result.repo.projectGroupId ?? 'none'}`
}
