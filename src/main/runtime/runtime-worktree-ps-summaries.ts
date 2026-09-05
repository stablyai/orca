import { DEFAULT_WORKSPACE_STATUS_ID } from '../../shared/workspace-statuses'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { folderWorkspaceToWorktree } from '../../shared/folder-workspace-worktree'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

export function buildRuntimeWorktreePsSummaries(args: {
  store: RuntimeStore | null
  resolvedWorktrees: readonly ResolvedWorktree[]
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
}): Map<string, RuntimeWorktreePsSummary> {
  const repoById = new Map((args.store?.getRepos() ?? []).map((repo) => [repo.id, repo]))
  const summaries = new Map<string, RuntimeWorktreePsSummary>()
  const ghCache = args.store?.getGitHubCache?.()
  for (const worktree of args.resolvedWorktrees) {
    const meta =
      args.store?.getWorktreeMeta?.(worktree.id) ?? args.store?.getAllWorktreeMeta()[worktree.id]
    const repo = repoById.get(worktree.repoId)
    let linkedPR: { number: number; state: string } | null = null
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    if (branch && ghCache) {
      const cached =
        (repo?.id ? ghCache.pr[`${repo.id}::${branch}`] : undefined) ??
        (repo?.path ? ghCache.pr[`${repo.path}::${branch}`] : undefined)
      if (cached?.data) {
        linkedPR = { number: cached.data.number, state: cached.data.state }
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
      ...(worktree.instanceId !== undefined ? { worktreeInstanceId: worktree.instanceId } : {}),
      ...(lineage?.worktreeInstanceId !== undefined
        ? { lineageWorktreeInstanceId: lineage.worktreeInstanceId }
        : {}),
      ...(lineage?.parentWorktreeInstanceId !== undefined
        ? { parentWorktreeInstanceId: lineage.parentWorktreeInstanceId }
        : {}),
      parentWorktreeId: worktree.parentWorktreeId,
      childWorktreeIds: worktree.childWorktreeIds,
      displayName: worktree.displayName,
      workspaceStatus: meta?.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
      sortOrder: meta?.sortOrder ?? 0,
      ...(meta?.manualOrder !== undefined ? { manualOrder: meta.manualOrder } : {}),
      lastActivityAt: worktree.lastActivityAt,
      ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
      ...(worktree.creatorProvenance ? { creatorProvenance: worktree.creatorProvenance } : {}),
      linkedIssue: worktree.linkedIssue,
      linkedPR,
      linkedLinearIssue: meta?.linkedLinearIssue ?? null,
      linkedGitLabMR: meta?.linkedGitLabMR ?? null,
      linkedGitLabIssue: meta?.linkedGitLabIssue ?? null,
      comment: meta?.comment ?? '',
      isPinned: meta?.isPinned ?? false,
      isActive: false,
      unread: meta?.isUnread ?? false,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      lastOutputAt: null,
      preview: '',
      status: 'inactive',
      agents: []
    })
  }
  const projectGroupById = new Map(
    (args.store?.getProjectGroups?.() ?? []).map((group) => [group.id, group])
  )
  for (const folderWorkspace of args.store?.getFolderWorkspaces?.() ?? []) {
    const projectGroup = projectGroupById.get(folderWorkspace.projectGroupId)
    if (!projectGroup?.parentPath) {
      continue
    }
    const worktree = folderWorkspaceToWorktree(folderWorkspace)
    summaries.set(worktree.id, {
      workspaceKind: 'folder-workspace',
      worktreeId: worktree.id,
      repoId: worktree.repoId,
      repo: projectGroup.name,
      path: worktree.path,
      branch: worktree.branch,
      isArchived: worktree.isArchived,
      isMainWorktree: worktree.isMainWorktree,
      hasHostSidebarActivity: false,
      ...(worktree.instanceId !== undefined ? { worktreeInstanceId: worktree.instanceId } : {}),
      parentWorktreeId: null,
      childWorktreeIds: [],
      displayName: worktree.displayName,
      workspaceStatus: worktree.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
      sortOrder: worktree.sortOrder ?? 0,
      ...(worktree.manualOrder !== undefined ? { manualOrder: worktree.manualOrder } : {}),
      lastActivityAt: worktree.lastActivityAt,
      ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
      ...(worktree.creatorProvenance ? { creatorProvenance: worktree.creatorProvenance } : {}),
      linkedIssue: worktree.linkedIssue ?? null,
      linkedPR: null,
      linkedLinearIssue: worktree.linkedLinearIssue ?? null,
      linkedGitLabMR: worktree.linkedGitLabMR ?? null,
      linkedGitLabIssue: worktree.linkedGitLabIssue ?? null,
      comment: worktree.comment,
      isPinned: worktree.isPinned,
      isActive: false,
      unread: worktree.isUnread,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      lastOutputAt: null,
      preview: '',
      status: 'inactive',
      agents: []
    })
  }
  return summaries
}
