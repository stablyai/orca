import type { ProjectGroup } from '../shared/types'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

export type RuntimeProjectGroupList = {
  groups: ProjectGroup[]
}

// Why: projectGroup.* RPCs take raw group ids, and the store silently maps an
// unknown id to null (ungrouping the repo). Resolving selectors client-side and
// failing loudly is the only guard against a typo silently ungrouping.
export function resolveProjectGroupFromList(groups: ProjectGroup[], selector: string): ProjectGroup {
  let candidates: ProjectGroup[]
  if (selector.startsWith('id:')) {
    candidates = groups.filter((group) => group.id === selector.slice(3))
  } else if (selector.startsWith('name:')) {
    candidates = groups.filter((group) => group.name === selector.slice(5))
  } else {
    const byId = groups.filter((group) => group.id === selector)
    candidates = byId.length > 0 ? byId : groups.filter((group) => group.name === selector)
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
  throw new RuntimeClientError(
    'selector_not_found',
    `No project group matches "${selector}".`,
    { nextSteps: ['Run `orca repo group list` to see saved groups.'] }
  )
}

export async function resolveProjectGroup(
  client: RuntimeClient,
  selector: string
): Promise<ProjectGroup> {
  const response = await client.call<RuntimeProjectGroupList>('projectGroup.list')
  return resolveProjectGroupFromList(response.result.groups, selector)
}
