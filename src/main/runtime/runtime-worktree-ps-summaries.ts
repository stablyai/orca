import { runtimeVisibleFolderWorkspaces } from './runtime-visible-catalog'
import type { WorktreeWithResolvedLineage } from '../../shared/resolved-worktree-lineage'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'
import type { Worktree } from '../../shared/worktree/types'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../shared/workspace-statuses'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { folderWorkspaceToWorktree } from '../../shared/folder-workspace-worktree'
import { getWorkspaceAttachments } from '../../shared/workspace-attachments'
import { getWorkspaceRowKindFacts } from '../../shared/worktree/workspace-kinds'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

export function buildRuntimeWorktreePsSummaries(args: {
  store: RuntimeStore | null
  resolvedWorktrees: readonly ResolvedWorktree[]
  folderWorktrees?: readonly WorktreeWithResolvedLineage[]
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
}): Map<string, RuntimeWorktreePsSummary> {
  const repoById = new Map((args.store?.getRepos() ?? []).map((repo) => [repo.id, repo]))
  const projectGroupById = new Map(
    (args.store?.getProjectGroups?.() ?? []).map((group) => [group.id, group])
  )
  const folders = (args.store ? runtimeVisibleFolderWorkspaces(args.store) : []).filter(
    (folder) => projectGroupById.get(folder.projectGroupId)?.parentPath
  )
  const folderLineageById = args.folderWorktrees?.length
    ? new Map(args.folderWorktrees.map((row) => [row.id, row]))
    : undefined
  const summaries = new Map<string, RuntimeWorktreePsSummary>()
  const ghCache = args.store?.getGitHubCache?.()
  for (const worktree of args.resolvedWorktrees) {
    const meta =
      args.store?.getWorktreeMeta?.(worktree.id) ?? args.store?.getAllWorktreeMeta()[worktree.id]
    const repo = repoById.get(worktree.repoId)
    let linkedPR: RuntimeWorktreePsSummary['linkedPR'] = null
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    if (branch && ghCache) {
      const cached =
        (repo?.id ? ghCache.pr[`${repo.id}::${branch}`] : undefined) ??
        (repo?.path ? ghCache.pr[`${repo.path}::${branch}`] : undefined)
      if (cached?.data) {
        const { number, state, title, url, checksStatus } = cached.data
        linkedPR = { number, state, title, url, checksStatus }
      }
    }
    if (!linkedPR && meta?.linkedPR != null) {
      linkedPR = { number: meta.linkedPR, state: 'unknown' }
    }
    const lineage = worktree.lineage
    summaries.set(worktree.id, {
      workspaceKind: 'git',
      worktreeId: worktree.id,
      repoId: worktree.repoId,
      ...((meta?.hostId ?? worktree.hostId) ? { hostId: meta?.hostId ?? worktree.hostId } : {}),
      terminalPlatform: args.platformByRepoId.get(worktree.repoId) ?? process.platform,
      repo: repo?.displayName ?? worktree.repoId,
      path: worktree.path,
      branch: worktree.branch,
      isArchived: worktree.isArchived,
      isMainWorktree: worktree.isMainWorktree,
      hasHostSidebarActivity: false,
      ...getWorkspaceRowKindFacts(worktree, repo),
      ...(worktree.removalError ? { removalError: worktree.removalError } : {}),
      ...(worktree.instanceId !== undefined ? { worktreeInstanceId: worktree.instanceId } : {}),
      ...(lineage?.worktreeInstanceId !== undefined
        ? { lineageWorktreeInstanceId: lineage.worktreeInstanceId }
        : {}),
      ...(lineage?.parentWorktreeInstanceId !== undefined
        ? { parentWorktreeInstanceId: lineage.parentWorktreeInstanceId }
        : {}),
      savedLineage:
        worktree.savedLineage !== undefined ? worktree.savedLineage : (worktree.lineage ?? null),
      parentWorktreeId: worktree.parentWorktreeId,
      childWorktreeIds: worktree.childWorktreeIds,
      displayName: worktree.displayName,
      workspaceStatus: meta?.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
      sortOrder: meta?.sortOrder ?? 0,
      ...(meta?.manualOrder !== undefined ? { manualOrder: meta.manualOrder } : {}),
      lastActivityAt: worktree.lastActivityAt,
      ...sortStampSummaryFields(worktree),
      ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
      ...(worktree.creatorProvenance ? { creatorProvenance: worktree.creatorProvenance } : {}),
      linkedIssue: worktree.linkedIssue,
      linkedPR,
      linkedLinearIssue: meta?.linkedLinearIssue ?? null,
      linkedGitLabMR: meta?.linkedGitLabMR ?? null,
      linkedGitLabIssue: meta?.linkedGitLabIssue ?? null,
      linkedItems: getWorkspaceAttachments(meta ?? worktree),
      comment: meta?.comment ?? '',
      isPinned: meta?.isPinned ?? false,
      isActive: false,
      unread: meta?.isUnread ?? false,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      unverifiableTerminalCount: 0,
      lastOutputAt: null,
      preview: '',
      status: 'inactive',
      agents: []
    })
  }
  for (const folderWorkspace of folders) {
    const projectGroup = projectGroupById.get(folderWorkspace.projectGroupId)!
    const worktree = folderWorkspaceToWorktree(folderWorkspace)
    const published = folderLineageById?.get(worktree.id)
    summaries.set(worktree.id, {
      workspaceKind: 'folder-workspace',
      hostId: worktree.hostId,
      worktreeId: worktree.id,
      repoId: worktree.repoId,
      repo: projectGroup.name,
      path: worktree.path,
      branch: worktree.branch,
      isArchived: worktree.isArchived,
      isMainWorktree: worktree.isMainWorktree,
      hasHostSidebarActivity: false,
      ...getWorkspaceRowKindFacts(worktree, undefined),
      ...(worktree.instanceId !== undefined ? { worktreeInstanceId: worktree.instanceId } : {}),
      savedLineage: published?.savedLineage ?? null,
      parentWorktreeId: published?.parentWorktreeId ?? null,
      childWorktreeIds: published?.childWorktreeIds ?? [],
      displayName: worktree.displayName,
      workspaceStatus: worktree.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
      sortOrder: worktree.sortOrder ?? 0,
      ...(worktree.manualOrder !== undefined ? { manualOrder: worktree.manualOrder } : {}),
      lastActivityAt: worktree.lastActivityAt,
      ...sortStampSummaryFields(worktree),
      ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
      ...(worktree.creatorProvenance ? { creatorProvenance: worktree.creatorProvenance } : {}),
      linkedIssue: worktree.linkedIssue ?? null,
      linkedPR: null,
      linkedLinearIssue: worktree.linkedLinearIssue ?? null,
      linkedGitLabMR: worktree.linkedGitLabMR ?? null,
      linkedGitLabIssue: worktree.linkedGitLabIssue ?? null,
      linkedItems: getWorkspaceAttachments(worktree),
      comment: worktree.comment,
      isPinned: worktree.isPinned,
      isActive: false,
      unread: worktree.isUnread,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      unverifiableTerminalCount: 0,
      lastOutputAt: null,
      preview: '',
      status: 'inactive',
      agents: []
    })
  }
  return summaries
}

// Switch point: a stamping host tells clients to sort by its stamps.
function sortStampSummaryFields(
  worktree: Pick<Worktree, 'smartTier' | 'smartAt'>
): Pick<RuntimeWorktreePsSummary, 'smartTier' | 'smartAt' | 'sortedByStamps'> {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    return {}
  }
  return {
    sortedByStamps: true,
    ...(worktree.smartTier !== undefined
      ? { smartTier: worktree.smartTier, smartAt: worktree.smartAt }
      : {})
  }
}
