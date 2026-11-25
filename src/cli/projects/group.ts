import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project/groups/project-group-types'
import { getProjectGroupSubtreeIds } from '../../shared/project/groups/project-groups'
import type { RuntimeRepoList } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import {
  getOptionalNumberFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import type { CommandHandler } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  formatGroupList,
  formatGroupRemoval,
  formatGroupShow,
  type GroupRemoval
} from './group-format'
import { listProjectGroups, resolveProjectGroupSelector } from './project-group-selector'
import { getOptionalHexColorFlag } from './sidebar-color-flag'

type GroupResult = { group: ProjectGroup | null }

function requireGroup(result: GroupResult, selector: string): { group: ProjectGroup } {
  if (!result.group) {
    throw new RuntimeClientError(
      'selector_not_found',
      `Project group ${selector} no longer exists. Run \`orca group list\` to see groups.`
    )
  }
  return { group: result.group }
}

async function setGroupParent(
  client: RuntimeClient,
  groups: readonly ProjectGroup[],
  group: ProjectGroup,
  parentGroupId: string | null
) {
  if (parentGroupId !== null && getProjectGroupSubtreeIds(groups, group.id).has(parentGroupId)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--parent must not be ${group.name} itself or a group nested inside it.`
    )
  }
  return client
    .call<{ group: ProjectGroup }>('projectGroup.setParent', { groupId: group.id, parentGroupId })
    .catch((error: unknown) => {
      if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'This Orca host cannot move a group under another group from the CLI, so nothing was changed. Update Orca on that host, or rerun without --parent.'
        )
      }
      throw error
    })
}

export const GROUP_HANDLERS: Record<string, CommandHandler> = {
  'group list': async ({ client, json }) => {
    const result = await client.call<{ groups: ProjectGroup[] }>('projectGroup.list')
    printResult(result, json, formatGroupList)
  },
  'group create': async ({ flags, client, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const parent = getOptionalStringFlag(flags, 'parent')
    const color = getOptionalHexColorFlag(flags, 'color', { allowNone: false })
    const parentGroupId =
      parent === undefined || parent === 'none'
        ? null
        : resolveProjectGroupSelector(await listProjectGroups(client), parent, 'parent').id
    const created = await client.call<{ group: ProjectGroup }>('projectGroup.create', {
      name,
      parentGroupId
    })
    if (color === undefined) {
      printResult(created, json, formatGroupShow)
      return
    }
    // projectGroup.create takes no color, so a colored group is created and then recolored.
    const colored = await client.call<GroupResult>('projectGroup.update', {
      groupId: created.result.group.id,
      updates: { color }
    })
    printResult(
      { ...colored, result: requireGroup(colored.result, created.result.group.id) },
      json,
      formatGroupShow
    )
  },
  'group set': async ({ flags, client, json }) => {
    const selector = getRequiredStringFlag(flags, 'group')
    const name = getOptionalStringFlag(flags, 'name')
    const parent = getOptionalStringFlag(flags, 'parent')
    const color = getOptionalHexColorFlag(flags, 'color', { allowNone: true })
    const order = getOptionalNumberFlag(flags, 'order')
    if (name === undefined && parent === undefined && color === undefined && order === undefined) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass at least one of --name, --parent, --color or --order.'
      )
    }
    const groups = await listProjectGroups(client)
    let group = resolveProjectGroupSelector(groups, selector, 'group')
    const parentGroupId =
      parent === undefined || parent === 'none'
        ? null
        : resolveProjectGroupSelector(groups, parent, 'parent').id
    // Re-parent first: a host without it refuses before any other field is saved.
    const moved =
      parent === undefined ? null : await setGroupParent(client, groups, group, parentGroupId)
    group = moved?.result.group ?? group
    const updates = {
      ...(name === undefined ? {} : { name }),
      ...(color === undefined ? {} : { color }),
      // Top-level groups share one ranking with ungrouped projects once the sidebar has one.
      ...(order === undefined
        ? {}
        : !group.parentGroupId && group.rootProjectOrder !== undefined
          ? { rootProjectOrder: order }
          : { tabOrder: order })
    }
    if (moved && Object.keys(updates).length === 0) {
      printResult(moved, json, formatGroupShow)
      return
    }
    const updated = await client.call<GroupResult>('projectGroup.update', {
      groupId: group.id,
      updates
    })
    printResult(
      { ...updated, result: requireGroup(updated.result, selector) },
      json,
      formatGroupShow
    )
  },
  'group rm': async ({ flags, client, json }) => {
    const selector = getRequiredStringFlag(flags, 'group')
    const groups = await listProjectGroups(client)
    const group = resolveProjectGroupSelector(groups, selector, 'group')
    const subtreeIds = getProjectGroupSubtreeIds(groups, group.id)
    const [{ repos }, { folderWorkspaces }] = await Promise.all([
      client.call<RuntimeRepoList>('repo.list').then((response) => response.result),
      client
        .call<{ folderWorkspaces: FolderWorkspace[] }>('folderWorkspace.list')
        .then((response) => response.result)
    ])
    const contents = {
      ungroupedProjects: repos.filter(
        (repo) => typeof repo.projectGroupId === 'string' && subtreeIds.has(repo.projectGroupId)
      ).length,
      removedChildGroups: subtreeIds.size - 1,
      removedFolderWorkspaces: folderWorkspaces.filter((workspace) =>
        subtreeIds.has(workspace.projectGroupId)
      ).length
    }
    if (flags.get('force') !== true && Object.values(contents).some((count) => count > 0)) {
      throw new RuntimeClientError(
        'group_not_empty',
        `Project group ${group.name} is not empty: ${contents.ungroupedProjects} project(s), ${contents.removedChildGroups} nested group(s), ${contents.removedFolderWorkspaces} folder workspace(s). Nothing was removed.`,
        {
          group: { id: group.id, name: group.name },
          projects: contents.ungroupedProjects,
          childGroups: contents.removedChildGroups,
          folderWorkspaces: contents.removedFolderWorkspaces,
          nextSteps: [
            'To keep the group until it is empty, move each project out with `orca repo set --repo <selector> --group none`.',
            `To remove it now, rerun with --force: its projects stay in Orca and move to no group, and the nested groups and folder workspaces in ${group.name} are removed from Orca. No files on disk are deleted.`
          ]
        }
      )
    }
    const deleted = await client.call<{ deleted: boolean }>('projectGroup.delete', {
      groupId: group.id
    })
    const removal: GroupRemoval = {
      deleted: deleted.result.deleted,
      group: { id: group.id, name: group.name },
      ...contents
    }
    printResult({ ...deleted, result: removal }, json, formatGroupRemoval)
  }
}
