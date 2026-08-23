import type { ProjectGroup } from '../../shared/project-group-types'
import { normalizeRepoBadgeColor } from '../../shared/repo-badge-color'
import type { CommandHandler } from '../dispatch'
import { formatProjectGroupList, formatProjectGroupShow, printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import type { RuntimeProjectGroupList } from '../project-group-selector'
import {
  filterProjectGroupsForConnection,
  getProjectGroupConnectionScope,
  resolveProjectGroup
} from '../project-group-selector'
import { RuntimeClientError } from '../runtime-client'

export const REPO_GROUP_HANDLERS: Record<string, CommandHandler> = {
  'repo group list': async ({ client, env, json }) => {
    const result = await client.call<RuntimeProjectGroupList>('projectGroup.list')
    const groups = filterProjectGroupsForConnection(
      result.result.groups,
      getProjectGroupConnectionScope(env)
    )
    printResult({ ...result, result: { groups } }, json, formatProjectGroupList)
  },
  'repo group create': async ({ flags, client, env, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const parentGroupSelector = getOptionalStringFlag(flags, 'parent-group')
    const connectionScope = getProjectGroupConnectionScope(env)
    const parentGroup =
      parentGroupSelector === undefined
        ? undefined
        : await resolveProjectGroup(client, parentGroupSelector, connectionScope)
    const connectionId = parentGroup?.connectionId?.trim() || connectionScope
    const result = await client.call<{ group: ProjectGroup }>('projectGroup.create', {
      name,
      ...(parentGroup === undefined ? {} : { parentGroupId: parentGroup.id }),
      ...(connectionId === undefined ? {} : { connectionId })
    })
    printResult(result, json, formatProjectGroupShow)
  },
  'repo group set': async ({ flags, client, env, json }) => {
    const connectionId = getProjectGroupConnectionScope(env)
    const group = await resolveProjectGroup(
      client,
      getRequiredStringFlag(flags, 'group'),
      connectionId
    )
    const updates: Record<string, unknown> = {}
    const name = getOptionalStringFlag(flags, 'name')
    if (name !== undefined) {
      updates.name = name
    }
    const color = getOptionalStringFlag(flags, 'color')
    if (color !== undefined) {
      if (color === 'null') {
        updates.color = null
      } else {
        const normalized = normalizeRepoBadgeColor(color)
        if (normalized === null) {
          throw new RuntimeClientError(
            'invalid_argument',
            `Invalid --color "${color}". Pass a hex color like #ff8800 or null.`
          )
        }
        updates.color = normalized
      }
    }
    if (Object.keys(updates).length === 0) {
      throw new RuntimeClientError('invalid_argument', 'Pass at least one of --name, --color.')
    }
    const result = await client.call<{ group: ProjectGroup | null }>('projectGroup.update', {
      groupId: group.id,
      updates,
      ...(connectionId === undefined ? {} : { connectionId })
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
  'repo group rm': async ({ flags, client, env, json }) => {
    const connectionId = getProjectGroupConnectionScope(env)
    const group = await resolveProjectGroup(
      client,
      getRequiredStringFlag(flags, 'group'),
      connectionId
    )
    const result = await client.call<{ deleted: boolean }>('projectGroup.delete', {
      groupId: group.id,
      ...(connectionId === undefined ? {} : { connectionId })
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
