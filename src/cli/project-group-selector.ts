import type { ProjectGroup } from '../shared/project-group-types'
import { readOrchestrationCompatibilityEvidence } from '../shared/orchestration-compatibility-evidence'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

export type RuntimeProjectGroupList = {
  groups: ProjectGroup[]
}

export function getProjectGroupConnectionScope(
  env: Readonly<NodeJS.ProcessEnv> | undefined
): string | undefined {
  if (!env) {
    return undefined
  }
  const host = readOrchestrationCompatibilityEvidence(env)?.host
  return host?.kind === 'ssh' ? host.targetId : undefined
}

export function filterProjectGroupsForConnection(
  groups: ProjectGroup[],
  connectionId: string | undefined
): ProjectGroup[] {
  if (connectionId === undefined) {
    return groups
  }
  return groups.filter((group) => group.connectionId?.trim() === connectionId)
}

export function assertProjectGroupMatchesRepoHost(
  group: Pick<ProjectGroup, 'connectionId'>,
  repo: { connectionId?: string | null }
): void {
  const groupConnectionId = group.connectionId?.trim() || null
  const repoConnectionId = repo.connectionId?.trim() || null
  if (groupConnectionId !== repoConnectionId) {
    throw new RuntimeClientError(
      'invalid_argument',
      'The repo and project group belong to different execution hosts.'
    )
  }
}

// Why: projectGroup.* RPCs take raw group ids, and the store silently maps an
// unknown id to null (ungrouping the repo). Resolving selectors client-side and
// failing loudly is the only guard against a typo silently ungrouping.
export function resolveProjectGroupFromList(
  groups: ProjectGroup[],
  selector: string,
  connectionId?: string
): ProjectGroup {
  const scopedGroups = filterProjectGroupsForConnection(groups, connectionId)
  let candidates: ProjectGroup[]
  if (selector.startsWith('id:')) {
    candidates = scopedGroups.filter((group) => group.id === selector.slice(3))
  } else if (selector.startsWith('name:')) {
    candidates = scopedGroups.filter((group) => group.name === selector.slice(5))
  } else {
    const byId = scopedGroups.filter((group) => group.id === selector)
    candidates = byId.length > 0 ? byId : scopedGroups.filter((group) => group.name === selector)
  }
  if (candidates.length === 1) {
    return candidates[0]
  }
  if (candidates.length > 1) {
    throw new RuntimeClientError(
      'selector_ambiguous',
      `Project group selector "${selector}" matches ${candidates.length} groups. Use id:<groupId>.`,
      { nextSteps: ['Run `orca repo group list` to see group ids.'] }
    )
  }
  throw new RuntimeClientError('selector_not_found', `No project group matches "${selector}".`, {
    nextSteps: ['Run `orca repo group list` to see saved groups.']
  })
}

export async function resolveProjectGroup(
  client: RuntimeClient,
  selector: string,
  connectionId?: string
): Promise<ProjectGroup> {
  const response = await client.call<RuntimeProjectGroupList>('projectGroup.list')
  return resolveProjectGroupFromList(response.result.groups, selector, connectionId)
}
