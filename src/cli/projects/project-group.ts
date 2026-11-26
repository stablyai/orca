import type { ProjectGroup } from '../../shared/project/groups/project-group-types'
import type { Repo } from '../../shared/repository/repo-types'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import {
  getOptionalNumberFlag,
  getPresentStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import { findProjectGroup } from './project-group-selector'
import { formatProjectGroupList, formatProjectGroupShow } from './project-group-format'
import { formatRepoShow } from './repo-format'

async function resolveGroupFlag(
  client: HandlerContext['client'],
  selector: string,
  flag: string
): Promise<ProjectGroup> {
  const { groups } = (await client.call<{ groups: ProjectGroup[] }>('projectGroup.list')).result
  return findProjectGroup(groups, selector, flag)
}

export const PROJECT_GROUP_HANDLERS: Record<string, CommandHandler> = {
  'project group list': async ({ client, json }) => {
    const result = await client.call<{ groups: ProjectGroup[] }>('projectGroup.list')
    printResult(result, json, formatProjectGroupList)
  },
  'project group create': async ({ flags, client, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const parentSelector = getPresentStringFlag(flags, 'parent-group')
    const parent =
      parentSelector === undefined
        ? undefined
        : await resolveGroupFlag(client, parentSelector, 'parent-group')
    const result = await client.call<{ group: ProjectGroup }>('projectGroup.create', {
      name,
      createdFrom: 'manual',
      ...(parent ? { parentGroupId: parent.id } : {})
    })
    printResult(result, json, formatProjectGroupShow)
  },
  'project group rename': async ({ flags, client, json }) => {
    const group = await resolveGroupFlag(client, getRequiredStringFlag(flags, 'group'), 'group')
    const result = await client.call<{ group: ProjectGroup | null }>('projectGroup.update', {
      groupId: group.id,
      updates: { name: getRequiredStringFlag(flags, 'name') }
    })
    const renamed = result.result.group
    if (!renamed) {
      throw new RuntimeClientError('invalid_argument', `Project group ${group.id} was not found.`)
    }
    printResult({ ...result, result: { group: renamed } }, json, formatProjectGroupShow)
  },
  'project group move': async ({ flags, client, json }) => {
    const repo = getRequiredStringFlag(flags, 'repo')
    const groupSelector = getPresentStringFlag(flags, 'group')
    const noGroup = flags.get('no-group') === true
    if ((groupSelector === undefined) === !noGroup) {
      throw new RuntimeClientError('invalid_argument', 'Pass exactly one of --group or --no-group.')
    }
    const order = getOptionalNumberFlag(flags, 'order')
    const groupId =
      groupSelector === undefined
        ? null
        : (await resolveGroupFlag(client, groupSelector, 'group')).id
    const result = await client.call<{ repo: Repo }>('projectGroup.moveProject', {
      repo,
      groupId,
      ...(order === undefined ? {} : { order })
    })
    // The host files an unknown group id as "no group" and still answers with the row.
    if ((result.result.repo.projectGroupId ?? null) !== groupId) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Project group ${groupId} was not found on the host that owns ${repo}; the repo is now outside every group.`,
        { nextSteps: ['Run `orca project group list` and retry with a listed group.'] }
      )
    }
    printResult(result, json, formatRepoShow)
  }
}
