import type { ProjectGroup } from '../../shared/types'
import type { CommandHandler } from '../dispatch'
import { formatProjectGroupList, formatProjectGroupShow, printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import type { RuntimeProjectGroupList } from '../project-group-selector'
import { resolveProjectGroup } from '../project-group-selector'
import { RuntimeClientError } from '../runtime-client'

export const REPO_GROUP_HANDLERS: Record<string, CommandHandler> = {
  'repo group list': async ({ client, json }) => {
    const result = await client.call<RuntimeProjectGroupList>('projectGroup.list')
    printResult(result, json, formatProjectGroupList)
  },
  'repo group create': async ({ flags, client, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const parentGroupSelector = getOptionalStringFlag(flags, 'parent-group')
    const parentGroupId =
      parentGroupSelector === undefined
        ? undefined
        : (await resolveProjectGroup(client, parentGroupSelector)).id
    const result = await client.call<{ group: ProjectGroup }>('projectGroup.create', {
      name,
      ...(parentGroupId === undefined ? {} : { parentGroupId })
    })
    printResult(result, json, formatProjectGroupShow)
  },
  'repo group set': async ({ flags, client, json }) => {
    const group = await resolveProjectGroup(client, getRequiredStringFlag(flags, 'group'))
    const updates: Record<string, unknown> = {}
    const name = getOptionalStringFlag(flags, 'name')
    if (name !== undefined) {
      updates.name = name
    }
    const color = getOptionalStringFlag(flags, 'color')
    if (color !== undefined) {
      updates.color = color === 'null' ? null : color
    }
    if (Object.keys(updates).length === 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass at least one of --name, --color.'
      )
    }
    const result = await client.call<{ group: ProjectGroup | null }>('projectGroup.update', {
      groupId: group.id,
      updates
    })
    // Why: the runtime returns { group: null } for an unknown id instead of an
    // error; surface that as a failure rather than printing "null".
    const updatedGroup = result.result.group
    if (!updatedGroup) {
      throw new RuntimeClientError(
        'selector_not_found',
        `Project group ${group.id} no longer exists.`
      )
    }
    printResult(result, json, () => formatProjectGroupShow({ group: updatedGroup }))
  },
  'repo group rm': async ({ flags, client, json }) => {
    const group = await resolveProjectGroup(client, getRequiredStringFlag(flags, 'group'))
    const result = await client.call<{ deleted: boolean }>('projectGroup.delete', {
      groupId: group.id
    })
    if (!result.result.deleted) {
      throw new RuntimeClientError(
        'selector_not_found',
        `Project group ${group.id} no longer exists.`
      )
    }
    printResult(result, json, () => `Removed project group ${group.name} (${group.id}).`)
  }
}
