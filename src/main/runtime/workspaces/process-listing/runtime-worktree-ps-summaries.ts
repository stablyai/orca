import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-list/feed/sidebar-inputs-switch'
import type { Worktree } from '../../../../shared/worktree/types'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../../../shared/workspace/status/workspace-statuses'
import {
  folderLineageEdgeOf,
  pickFolderLineageRecord
} from '../../../../shared/worktree/lineage/folder-lineage-parents'
import type { RuntimeWorktreePsSummary } from '../../../../shared/worktree/catalog/runtime-worktree-contracts'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments/workspace-attachments'
import { getWorkspaceRowKindFacts } from '../../../../shared/worktree/visibility/workspace-kinds'
import { readWorkspaceReviewPR } from '../../../../shared/sidebar-list/feed-facts/workspace-review-facts'
import { withOwnerRepos } from '../../../../shared/sidebar-list/feed-facts/workspace-rows'
import { UNCACHED_LINKED_PR_STATE } from '../../../../shared/worktree/catalog/runtime-worktree-contracts'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { WorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import { resolveWorkspaceLineageParents } from '../../../../shared/worktree/lineage/workspace-lineage-graph'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { workspaceKeyOfRow } from '../../../../shared/worktree/lineage/lineage-row-identity'
import { nearestBotHome } from '../../../../shared/bots/bot-workspace-owner'
import { runtimeVisibleFolderWorkspaces } from '../catalog/runtime-visible-catalog'
import type { ResolvedWorktree } from '../catalog/runtime-worktree-path-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { runtimeWorktreePsRowKey } from './runtime-worktree-summary-paths'

export function buildRuntimeWorktreePsSummaries(args: {
  store: RuntimeStore | null
  resolvedWorktrees: readonly ResolvedWorktree[]
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
  /** Only this workspace's rows (every host's copy); PTY liveness still reads every worktree. */
  worktreeId?: string
}): Map<string, RuntimeWorktreePsSummary> {
  const summaries = new Map<string, RuntimeWorktreePsSummary>()
  const botOf = botOwnerLookup(args.store, args.resolvedWorktrees)
  const metaByHost = new Map<ExecutionHostId, Record<string, WorktreeMeta>>()
  // A same-id twin on another host has its own metadata; an unhosted row keeps the id-keyed read.
  const readMeta = (worktree: ResolvedWorktree): WorktreeMeta | undefined => {
    const hostId = worktree.identity?.executionHostId ?? worktree.hostId
    if (!hostId || !args.store?.getAllWorktreeMetaForHost) {
      return (
        args.store?.getWorktreeMeta?.(worktree.id) ?? args.store?.getAllWorktreeMeta()[worktree.id]
      )
    }
    let hostMeta = metaByHost.get(hostId)
    if (!hostMeta) {
      hostMeta = args.store.getAllWorktreeMetaForHost(hostId)
      metaByHost.set(hostId, hostMeta)
    }
    return hostMeta[worktree.id]
  }
  const ghCache = args.store?.getGitHubCache?.()
  const crossStoreLineage = args.store?.getAllCrossStoreWorkspaceLineage?.() ?? {}
  const workspaceLineage = args.store?.getAllWorkspaceLineage?.()
  const resolvedWorktrees =
    args.worktreeId === undefined
      ? args.resolvedWorktrees
      : args.resolvedWorktrees.filter((worktree) => worktree.id === args.worktreeId)
  for (const { worktree, repo } of withOwnerRepos(
    resolvedWorktrees,
    args.store?.getRepos() ?? []
  )) {
    const meta = readMeta(worktree)
    // Why: read the cache entry the desktop's PR lanes read; an uncached link keeps its badge as state 'unknown'.
    const cachedPR = ghCache ? readWorkspaceReviewPR(worktree, repo, ghCache.pr) : null
    const linkedPR: RuntimeWorktreePsSummary['linkedPR'] = cachedPR
      ? {
          number: cachedPR.number,
          state: cachedPR.state,
          title: cachedPR.title,
          url: cachedPR.url,
          checksStatus: cachedPR.checksStatus,
          ...(cachedPR.checksSummary ? { checksSummary: cachedPR.checksSummary } : {})
        }
      : meta?.linkedPR != null
        ? { number: meta.linkedPR, state: UNCACHED_LINKED_PR_STATE }
        : null
    const lineage = worktree.lineage
    const recordedCrossStoreParent = crossStoreLineage[worktreeWorkspaceKey(worktree.id)]
    // Lineage keyed by workspace key belongs to the row whose instance recorded it.
    const crossStoreParent =
      recordedCrossStoreParent &&
      (!worktree.instanceId || recordedCrossStoreParent.childInstanceId === worktree.instanceId)
        ? recordedCrossStoreParent
        : undefined
    const priorWorktreeIds = meta?.priorWorktreeIds ?? worktree.priorWorktreeIds
    const hostId = meta?.hostId ?? worktree.hostId
    setPsSummary(summaries, {
      workspaceKind: 'git',
      worktreeId: worktree.id,
      repoId: worktree.repoId,
      ...(hostId ? { hostId } : {}),
      ...(worktree.identity ? { identity: worktree.identity } : {}),
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
      ...botOf(worktreeWorkspaceKey(worktree.id), worktree),
      ...(worktree.removalError ? { removalError: worktree.removalError } : {}),
      ...(worktree.removing ? { removing: true } : {}),
      ...(worktree.removalRecorded ? { removalRecorded: true } : {}),
      ...(worktree.instanceId !== undefined ? { worktreeInstanceId: worktree.instanceId } : {}),
      ...(lineage?.worktreeInstanceId !== undefined
        ? { lineageWorktreeInstanceId: lineage.worktreeInstanceId }
        : {}),
      ...(lineage?.parentWorktreeInstanceId !== undefined
        ? { parentWorktreeInstanceId: lineage.parentWorktreeInstanceId }
        : {}),
      parentWorktreeId: worktree.parentWorktreeId,
      childWorktreeIds: worktree.childWorktreeIds,
      ...(crossStoreParent ? { crossStoreParent } : {}),
      ...(workspaceLineage
        ? {
            workspaceLineage: folderLineageEdgeOf(
              workspaceLineage[worktreeWorkspaceKey(worktree.id)],
              worktree.instanceId
            )
          }
        : {}),
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
  for (const folderWorkspace of runtimeVisibleFolderWorkspaces(args.store)) {
    if (
      args.worktreeId !== undefined &&
      folderWorkspaceKey(folderWorkspace.id) !== args.worktreeId
    ) {
      continue
    }
    const projectGroup = projectGroupById.get(folderWorkspace.projectGroupId)
    if (!projectGroup) {
      continue
    }
    const worktree = folderWorkspaceToWorktree(folderWorkspace)
    setPsSummary(summaries, {
      workspaceKind: 'folder-workspace',
      worktreeId: worktree.id,
      repoId: worktree.repoId,
      // The phone names a row's machine from hostId; without it an SSH folder reads as local.
      hostId: worktree.hostId,
      repo: projectGroup.name,
      path: worktree.path,
      branch: worktree.branch,
      isArchived: worktree.isArchived,
      isMainWorktree: worktree.isMainWorktree,
      hasHostSidebarActivity: false,
      ...getWorkspaceRowKindFacts(worktree, undefined),
      ...botOf(folderWorkspaceKey(folderWorkspace.id), worktree),
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

/** The bot a workspace is under: the nearest bot home among the folders the sidebar's own parent
 * rules nest it beneath, however it got there. */
function botOwnerLookup(store: RuntimeStore | null, worktrees: readonly Worktree[]) {
  const lineage = store?.getAllWorkspaceLineage?.() ?? {}
  const botByHome = new Map(
    (store?.getBots?.() ?? []).map((bot) => [folderWorkspaceKey(bot.folderWorkspaceId), bot.name])
  )
  const rows = new Map(
    [...worktrees, ...(store?.getFolderWorkspaces?.() ?? []).map(folderWorkspaceToWorktree)].map(
      (row) => [getWorktreeHostIdentity(row), row]
    )
  )
  const parentOf = resolveWorkspaceLineageParents({}, rows, undefined, (row) =>
    pickFolderLineageRecord(lineage[workspaceKeyOfRow(row)], row)
  )
  const isHome = (row: Worktree) => botByHome.has(workspaceKeyOfRow(row))
  const parent = (row: Worktree) => parentOf.get(getWorktreeHostIdentity(row))
  return (key: WorkspaceKey, worktree: Worktree): { bot?: string; botHome?: true } => {
    const home = botByHome.get(key)
    if (home) {
      return { bot: home, botHome: true }
    }
    const homeRow = nearestBotHome(worktree, parent, isHome)
    const bot = homeRow ? botByHome.get(workspaceKeyOfRow(homeRow)) : undefined
    return bot ? { bot } : {}
  }
}

function setPsSummary(
  summaries: Map<string, RuntimeWorktreePsSummary>,
  summary: RuntimeWorktreePsSummary
): void {
  summaries.set(runtimeWorktreePsRowKey(summary), summary)
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
