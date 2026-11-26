import type { ProjectGroup } from '../../shared/project/groups/project-group-types'
import { normalizeTypedName } from '../../shared/text/typed-name-normalization'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'

export async function listProjectGroups(client: RuntimeClient): Promise<ProjectGroup[]> {
  return (await client.call<{ groups: ProjectGroup[] }>('projectGroup.list')).result.groups
}

/** `id:<id>`, `name:<name>`, or a bare value tried as an id and then as a name. */
export function resolveProjectGroupSelector(
  groups: readonly ProjectGroup[],
  selector: string,
  flag: string
): ProjectGroup {
  const idValue = selector.startsWith('id:') ? selector.slice(3) : null
  const nameValue = selector.startsWith('name:') ? selector.slice(5) : null
  if (nameValue === null) {
    const byId = groups.find((group) => group.id === (idValue ?? selector))
    if (byId) {
      return byId
    }
  }
  const named =
    idValue === null
      ? groups.filter(
          (group) => normalizeTypedName(group.name) === normalizeTypedName(nameValue ?? selector)
        )
      : []
  if (named.length === 1) {
    return named[0]
  }
  if (named.length === 0) {
    throw new RuntimeClientError(
      'selector_not_found',
      `No project group matches --${flag} ${selector}. Run \`orca group list\` to see groups.`
    )
  }
  throw new RuntimeClientError(
    'selector_ambiguous',
    `Ambiguous --${flag} ${selector}: ${named.length} groups are named that. Use the group id.`,
    {
      knownGroups: named.map((group) => ({
        id: group.id,
        name: group.name,
        parentGroupId: group.parentGroupId
      })),
      nextSteps: named.map((group) => `Use --${flag} id:${group.id}.`)
    }
  )
}
