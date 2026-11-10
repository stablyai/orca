import { MULTI_REPO_SYSTEM_GROUP_NAME } from '../../../src/shared/multi-repo-workspace'
import type { HostSectionRow } from '../../../src/shared/sidebar-list/host-section-rows'
import type { Section } from '../worktree/workspace-list-types'

/** Which multi-repo workspace each member worktree belongs to, from the feed's folder rows. */
export function collectMultiRepoMemberOf(
  rows: readonly HostSectionRow[]
): Map<string, { folderWorkspaceId: string; memberId: string }> {
  const result = new Map<string, { folderWorkspaceId: string; memberId: string }>()
  for (const row of rows) {
    if (row.type !== 'folder-workspace') {
      continue
    }
    for (const member of row.folderWorkspace.multiRepo?.members ?? []) {
      if (member.worktreeId) {
        result.set(member.worktreeId, {
          folderWorkspaceId: row.folderWorkspace.id,
          memberId: member.memberId
        })
      }
    }
  }
  return result
}

/** The header of the system project group that holds multi-repo workspaces. */
export function isMultiRepoSystemGroupHeader(
  row: Extract<HostSectionRow, { type: 'header' }>
): boolean {
  return (
    row.projectGroup !== undefined &&
    !row.repo &&
    'createdFrom' in row.projectGroup &&
    row.projectGroup.name === MULTI_REPO_SYSTEM_GROUP_NAME &&
    row.projectGroup.createdFrom === 'manual'
  )
}

/** Moves the system Workspaces sections to the top of their host block and drops empty ones. A collapsed section has no rows but keeps its count, so it stays expandable. */
export function hoistMultiRepoWorkspaceSections(
  sections: readonly Section[],
  workspaceSectionKeys: ReadonlySet<string>,
  hostHeaderKeys: ReadonlySet<string>
): Section[] {
  if (workspaceSectionKeys.size === 0) {
    return [...sections]
  }
  const result: Section[] = []
  let blockStart = 0
  let hoisted = 0
  for (const section of sections) {
    if (hostHeaderKeys.has(section.key)) {
      result.push(section)
      blockStart = result.length
      hoisted = 0
      continue
    }
    if (!workspaceSectionKeys.has(section.key)) {
      result.push(section)
      continue
    }
    if (section.data.length === 0 && !section.pendingCreations?.length && !section.count) {
      continue
    }
    result.splice(blockStart + hoisted, 0, section)
    hoisted += 1
  }
  return result
}
