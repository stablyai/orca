import { z } from 'zod'
import { normalizeRuntimePathForComparison as selectionKey } from '../../shared/cross-platform-path'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { ProjectGroup, ProjectGroupImportResult } from '../../shared/project-group-types'
import { createNestedProjectGroupResolver } from '../project-groups/nested-repo-import'
import type { WslMutationAuthority } from './project-placement'
import {
  mutateWslProject,
  StoppedWslMutation,
  UnsentWslSavedClaim
} from './wsl-project-registration'

export type PlacedNestedItem = { path: string; order: number; selectedLinuxPath: string }

const GroupReply = z.object({
  group: z.object({
    id: z.string(),
    name: z.string(),
    parentPath: z.string().nullable(),
    parentGroupId: z.string().nullable(),
    createdFrom: z.enum(['manual', 'folder-scan', 'migration']),
    tabOrder: z.number(),
    isCollapsed: z.boolean(),
    color: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number()
  })
})

const INCOMPLETE_GROUP = 'The project was added, but its group could not be completed.'

/**
 * Groups the guest's acknowledged project ids with its existing group methods, laid out by the
 * ordinary hierarchy from the original selections. No path is registered or resolved again.
 */
export async function groupOnWslOwner(args: {
  authority: WslMutationAuthority
  parentLinuxPath: string
  groupName: string
  items: readonly PlacedNestedItem[]
  results: Map<string, ProjectGroupImportResult['projects'][number]>
}): Promise<ProjectGroup | undefined> {
  const owner = toRuntimeExecutionHostId(args.authority.environmentId)
  const planned: ProjectGroup[] = []
  const layout = createNestedProjectGroupResolver({
    parentPath: args.parentLinuxPath,
    groupName: args.groupName,
    mode: 'group',
    repoPaths: args.items.map((item) => item.selectedLinuxPath),
    createGroup: (input) => {
      const group: ProjectGroup = {
        ...input,
        id: `planned-${planned.length}`,
        parentPath: input.parentPath ?? null,
        parentGroupId: input.parentGroupId ?? null,
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      }
      planned.push(group)
      return group
    }
  })
  const movedIds = new Set<string>()
  const moves = args.items.flatMap((item) => {
    const result = args.results.get(selectionKey(item.path))
    // Only this owner's acknowledged receipts are grouped; a Windows-owned result never is.
    if (
      !result?.projectId ||
      result.status === 'failed' ||
      result.executionHostId !== owner ||
      movedIds.has(result.projectId)
    ) {
      return []
    }
    movedIds.add(result.projectId)
    const plannedGroup = layout.getGroupForRepo(item.selectedLinuxPath)
    return plannedGroup ? [{ item, result, projectId: result.projectId, plannedGroup }] : []
  })
  if (moves.length === 0) {
    return undefined
  }
  const created = new Map<string, ProjectGroup>()
  const markIncomplete = (projectId: string) => {
    for (const [key, result] of args.results) {
      if (
        result.projectId === projectId &&
        result.executionHostId === owner &&
        result.status !== 'failed'
      ) {
        args.results.set(key, { ...result, status: 'failed', error: INCOMPLETE_GROUP })
      }
    }
  }
  try {
    args.authority.validate()
  } catch {
    for (const { projectId } of moves) {
      markIncomplete(projectId)
    }
    return undefined
  }
  let stopped = false
  for (const group of planned) {
    if (stopped || (group.parentGroupId && !created.has(group.parentGroupId))) {
      continue
    }
    try {
      const reply = GroupReply.parse(
        await mutateWslProject(args.authority, 'projectGroup.create', {
          name: group.name,
          parentPath: group.parentPath ?? undefined,
          parentGroupId: group.parentGroupId ? created.get(group.parentGroupId)!.id : null,
          createdFrom: group.createdFrom
        })
      )
      created.set(group.id, reply.group)
    } catch (error) {
      stopped = error instanceof StoppedWslMutation || error instanceof UnsentWslSavedClaim
    }
  }
  for (const { item, projectId, plannedGroup } of moves) {
    if (stopped || !created.has(plannedGroup.id)) {
      markIncomplete(projectId)
      continue
    }
    try {
      await mutateWslProject(args.authority, 'projectGroup.moveProject', {
        repo: `id:${projectId}`,
        groupId: created.get(plannedGroup.id)!.id,
        order: item.order
      })
    } catch (error) {
      markIncomplete(projectId)
      stopped = error instanceof StoppedWslMutation || error instanceof UnsentWslSavedClaim
    }
  }
  return created.get('planned-0')
}
