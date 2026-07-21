import { resolveTopLevelProjectGroupId } from '../../../src/shared/project-groups'
import { folderWorkspaceRepoId } from '../../../src/shared/folder-workspace-worktree'
import type { ProjectGroup } from '../../../src/shared/types'
import type { RepoSummary } from './host-worktree-rpc-types'
import type { ProjectGroupBucket } from './workspace-list-sections'

// Extract the ProjectGroup list from a projectGroup.list RPC response, degrading
// to empty when the call failed so the list falls back to "all ungrouped".
function parseProjectGroupsResponse(response: { ok: boolean; result?: unknown }): ProjectGroup[] {
  return response.ok
    ? ((response.result as { groups?: ProjectGroup[] } | undefined)?.groups ?? [])
    : []
}

// Map each repo to its resolved top-level project group (or null when ungrouped
// or the membership points at an unknown group), for the 'projectGroup' grouping
// mode. Nested subgroups collapse to their root so a repo renders under one folder.
export function buildProjectGroupByRepoId(
  repos: readonly RepoSummary[],
  groupResponse: { ok: boolean; result?: unknown }
): Map<string, ProjectGroupBucket | null> {
  const groups = parseProjectGroupsResponse(groupResponse)
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  // Memoized so a repeated groupId (many repos in one group, or the group's own
  // folder-workspace key) doesn't re-walk the parent chain each time.
  const bucketCache = new Map<string, ProjectGroupBucket | null>()
  const bucketFor = (groupId: string | null | undefined): ProjectGroupBucket | null => {
    if (!groupId) {
      return null
    }
    const cached = bucketCache.get(groupId)
    if (cached !== undefined) {
      return cached
    }
    const top = groupsById.get(resolveTopLevelProjectGroupId(groupsById, groupId))
    const bucket = top ? { groupId: top.id, groupName: top.name, tabOrder: top.tabOrder } : null
    bucketCache.set(groupId, bucket)
    return bucket
  }
  const byRepoId = new Map<string, ProjectGroupBucket | null>()
  for (const repo of repos) {
    byRepoId.set(repo.id, bucketFor(repo.projectGroupId))
  }
  // Why: folder-workspace worktrees carry a synthetic repoId encoding their owning
  // group (folderWorkspaceRepoId), so map each group's synthetic key too — else they
  // always fall into "Ungrouped" despite belonging to a folder.
  for (const group of groups) {
    byRepoId.set(folderWorkspaceRepoId(group.id), bucketFor(group.id))
  }
  return byRepoId
}
