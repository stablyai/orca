import { getSshTargetIdForExecutionHost } from '../../shared/execution-host'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { getPresentStringFlag, getRequiredStringFlag } from '../flags'
import {
  formatProjectGroup,
  formatProjectGroupList,
  formatProjectGroupMembership,
  type ProjectGroupListEntry
} from '../project-format'
import { resolveProjectGroup } from '../project-group-selector'
import { RuntimeClientError } from '../runtime-client'
import {
  assertWorkspaceTargetFlagsCompatible,
  resolveProjectCreateTarget
} from '../worktree-project-target'

type ProjectGroupMoveTarget = { repo: string; connectionId?: string | null }

async function resolveMoveTarget(
  flags: Map<string, string | boolean>,
  client: HandlerContext['client']
): Promise<ProjectGroupMoveTarget> {
  assertWorkspaceTargetFlagsCompatible(flags)
  const projectTarget = await resolveProjectCreateTarget(flags, client)
  if (projectTarget) {
    // The move RPC has no host field; connectionId is what separates local and SSH twins.
    return {
      repo: projectTarget.repoSelector,
      connectionId: getSshTargetIdForExecutionHost(projectTarget.repoHostId)
    }
  }
  const repo = getPresentStringFlag(flags, 'repo')
  if (repo) {
    return { repo }
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'Missing project selector. Pass --project <id-or-name> [--host <host>], --project-host-setup <id>, or --repo <selector>.'
  )
}

async function moveProject(
  client: HandlerContext['client'],
  target: ProjectGroupMoveTarget,
  groupId: string | null,
  json: boolean
): Promise<void> {
  const result = await client.call<{ repo: Repo }>('projectGroup.moveProject', {
    ...target,
    groupId
  })
  printResult(result, json, formatProjectGroupMembership)
}

function groupNotFound(group: ProjectGroup): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', `Project group not found: ${group.id}`)
}

export const PROJECT_GROUP_HANDLERS: Record<string, CommandHandler> = {
  'project group list': async ({ client, json }) => {
    const [groups, repos] = await Promise.all([
      client.call<{ groups: ProjectGroup[] }>('projectGroup.list'),
      client.call<{ repos: Repo[] }>('repo.list')
    ])
    const entries: ProjectGroupListEntry[] = groups.result.groups.map((group) => ({
      ...group,
      repos: repos.result.repos
        .filter((repo) => repo.projectGroupId === group.id)
        .sort(
          (left, right) =>
            (left.projectGroupOrder ?? Number.MAX_SAFE_INTEGER) -
            (right.projectGroupOrder ?? Number.MAX_SAFE_INTEGER)
        )
        .map((repo) => ({ id: repo.id, displayName: repo.displayName }))
    }))
    printResult({ ...groups, result: { groups: entries } }, json, formatProjectGroupList)
  },
  'project group create': async ({ flags, client, json }) => {
    const result = await client.call<{ group: ProjectGroup }>('projectGroup.create', {
      name: getRequiredStringFlag(flags, 'name')
    })
    printResult(result, json, ({ group }) => formatProjectGroup(group))
  },
  'project group rename': async ({ flags, client, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const group = await resolveProjectGroup(client, getRequiredStringFlag(flags, 'group'))
    const result = await client.call<{ group: ProjectGroup | null }>('projectGroup.update', {
      groupId: group.id,
      updates: { name }
    })
    const renamed = result.result.group
    if (!renamed) {
      throw groupNotFound(group)
    }
    printResult({ ...result, result: { group: renamed } }, json, ({ group }) =>
      formatProjectGroup(group)
    )
  },
  'project group rm': async ({ flags, client, json }) => {
    const group = await resolveProjectGroup(client, getRequiredStringFlag(flags, 'group'))
    const result = await client.call<{ deleted: boolean }>('projectGroup.delete', {
      groupId: group.id
    })
    if (!result.result.deleted) {
      throw groupNotFound(group)
    }
    printResult(
      { ...result, result: { deleted: true, group } },
      json,
      () => `deleted: ${formatProjectGroup(group)}`
    )
  },
  'project group add': async ({ flags, client, json }) => {
    const groupSelector = getRequiredStringFlag(flags, 'group')
    const target = await resolveMoveTarget(flags, client)
    const group = await resolveProjectGroup(client, groupSelector)
    await moveProject(client, target, group.id, json)
  },
  'project group ungroup': async ({ flags, client, json }) => {
    await moveProject(client, await resolveMoveTarget(flags, client), null, json)
  }
}
