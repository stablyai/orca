import type { ProjectGroup } from '../../shared/project/groups/project-group-types'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { normalizeTypedName } from '../../shared/text/typed-name-normalization'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'

const UNGROUPED_PROJECT_GROUP_SELECTOR = 'none'

export async function listProjectGroups(
  client: RuntimeClient
): Promise<RuntimeRpcSuccess<{ groups: ProjectGroup[] }>> {
  try {
    return await client.call<{ groups: ProjectGroup[] }>('projectGroup.list')
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca server does not support project groups yet. Update Orca on the server and try again.'
      )
    }
    throw error
  }
}

/** Resolves `--project-group` to a group id, or null for `none` (ungrouped). */
export async function resolveProjectGroupSelector(
  client: RuntimeClient,
  selector: string
): Promise<string | null> {
  if (normalizeTypedName(selector) === UNGROUPED_PROJECT_GROUP_SELECTOR) {
    return null
  }
  const { groups } = (await listProjectGroups(client)).result
  // Never pass an unchecked id through: the runtime ungroups a repo moved to an unknown group.
  if (groups.some((group) => group.id === selector)) {
    return selector
  }
  const named = groups.filter(
    (group) => normalizeTypedName(group.name) === normalizeTypedName(selector)
  )
  if (named.length === 1) {
    return named[0].id
  }
  if (named.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Ambiguous --project-group ${selector}: ${named.length} project groups are named that. Use the group id.`,
      {
        knownProjectGroups: named.map((group) => ({ id: group.id, name: group.name })),
        nextSteps: named.map(
          (group) => `Use --project-group ${group.id} for ${describeProjectGroup(group, groups)}.`
        )
      }
    )
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `No project group matches --project-group ${selector}.`,
    {
      knownProjectGroups: groups.map((group) => ({ id: group.id, name: group.name })),
      nextSteps: [
        groups.length > 0
          ? 'Run `orca repo group list` to see project group ids and names, or pass --project-group none to ungroup the repo.'
          : 'This Orca has no project groups yet. Create one from the sidebar, then rerun this command.'
      ]
    }
  )
}

export function describeProjectGroup(group: ProjectGroup, groups: readonly ProjectGroup[]): string {
  const parent = groups.find((candidate) => candidate.id === group.parentGroupId)
  return parent ? `${group.name} (in ${parent.name})` : group.name
}
