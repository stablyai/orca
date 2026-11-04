import type { ProjectGroup } from '../shared/project-group-types'
import { normalizeTypedName } from '../shared/typed-name-normalization'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

// Never pass an unmatched selector through: projectGroup.moveProject ungroups on an unknown id.
export async function resolveProjectGroup(
  client: RuntimeClient,
  groupSelector: string
): Promise<ProjectGroup> {
  const { groups } = (await client.call<{ groups: ProjectGroup[] }>('projectGroup.list')).result
  const byId = groups.find((group) => group.id === groupSelector)
  if (byId) {
    return byId
  }
  const wanted = normalizeTypedName(groupSelector)
  const named = groups.filter((group) => normalizeTypedName(group.name) === wanted)
  if (named.length === 1) {
    return named[0]
  }
  if (named.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Ambiguous --group ${groupSelector}: ${named.length} project groups are named that. Use the group id.`,
      {
        knownProjectGroups: named.map((group) => ({ id: group.id, name: group.name })),
        nextSteps: named.map((group) => `Use --group ${group.id} for ${group.name}.`)
      }
    )
  }
  throw new RuntimeClientError('invalid_argument', `Project group not found: ${groupSelector}`, {
    nextSteps: ['Run `orca project group list` for group ids and names.']
  })
}
