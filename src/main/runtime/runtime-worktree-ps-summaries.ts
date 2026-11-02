import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'
import type { Worktree } from '../../shared/worktree/types'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../shared/workspace-statuses'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { folderWorkspaceToWorktree } from '../../shared/folder-workspace-worktree'
import { getWorkspaceAttachments } from '../../shared/workspace-attachments'
import { getWorkspaceRowKindFacts } from '../../shared/worktree/workspace-kinds'
import { readWorkspaceReviewPR } from '../../shared/sidebar-list/workspace-review-facts'
import { withOwnerRepos } from '../../shared/sidebar-list/workspace-rows'
import { UNCACHED_LINKED_PR_STATE } from '../../shared/runtime-worktree-contracts'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

export function buildRuntimeWorktreePsSummaries(args: {
  store: RuntimeStore | null
  resolvedWorktrees: readonly ResolvedWorktree[]
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
}): Map<string, RuntimeWorktreePsSummary> {
  const summaries = new Map<string, RuntimeWorktreePsSummary>()
  const ghCache = args.store?.getGitHubCache?.()
  for (const { worktree, repo } of withOwnerRepos(
    args.resolvedWorktrees,
    args.store?.getRepos() ?? []
  )) {
    const meta =
      args.store?.getWorktreeMeta?.(worktree.id) ?? args.store?.getAllWorktreeMeta()[worktree.id]
    // Why: read the cache entry the desktop's PR lanes read; an uncached link keeps its badge as state 'unknown'.
    const cachedPR = ghCache ? readWorkspaceReviewPR(worktree, repo, ghCache.pr) : null
    const linkedPR: RuntimeWorktreePsSummary['linkedPR'] = cachedPR
      ? {
          number: cachedPR.number,
          state: cachedPR.state,
          title: cachedPR.title,
          url: cachedPR.url,
          checksStatus: cachedPR.checksStatus
        }
      : meta?.linkedPR != null
        ? { number: meta.linkedPR, state: UNCACHED_LINKED_PR_STATE }
        : null
    const lineage = worktree.lineage
    const priorWorktreeIds = meta?.priorWorktreeIds ?? worktree.priorWorktreeIds
    summaries.set(worktree.id, {
      workspaceKind: 'git',
      worktreeId: worktree.id,
      repoId: worktree.repoId,
      ...((meta?.hostId ?? worktree.hostId) ? { hostId: meta?.hostId ?? worktree.hostId } : {}),
      terminalPlatform: args.platformByRepoId.get(worktree.repoId) ?? process.platform,
      repo: repo?.displayName ?? worktree.repoId,
      path: worktree.path,
      // Session history follows a renamed or moved workspace to its older paths.
      ...(priorWorktreeIds?.length ? { priorWorktreeIds } : {}),
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
      ...getWorkspaceRowKindFacts(worktree, undefined),
      ...(worktree.instanceId !== undefined ? { worktreeInstanceId: worktree.instanceId } : {}),
      parentWorktreeId: null,
      childWorktreeIds: [],
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
