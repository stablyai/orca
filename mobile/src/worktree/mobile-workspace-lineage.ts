import {
  buildWorktreeOccurrencePlan,
  getExpandedWorktreeOccurrences,
  type WorktreeOccurrencePlan
} from '../../../src/shared/worktree-occurrence-plan'
import type { WorkspaceListItem, Worktree } from './workspace-list-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import { resolveLineageParentsByPolicy } from '../../../src/shared/worktree/workspace-lineage-graph'
import type { WorkspaceLineageEdge } from '../../../src/shared/worktree/lineage-types'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import {
  buildCrossStoreLineageViewOfRows,
  OWN_LINEAGE_STORE_KEY,
  type CrossStoreLineageView
} from '../../../src/shared/worktree/cross-store-lineage-resolution'
import {
  NO_WORKTREE_HOST_CONTEXT,
  type WorktreeHostContextOf
} from './worktree-host-context-labels'
import { getWorktreeRowIdentity } from './worktree-host-row-identity'

type WorktreeLineageIdentitySource = Pick<Worktree, 'worktreeId' | 'hostId'>

export function getMobileWorkspaceLineageGroupKey(worktree: WorktreeLineageIdentitySource): string {
  return `workspace-lineage:${encodeURIComponent(getWorktreeRowIdentity(worktree))}`
}

/** The row fields lineage reads; a caller may resolve over a projection of its rows. */
export type MobileLineageRow = Pick<
  Worktree,
  | 'worktreeId'
  | 'hostId'
  | 'repoId'
  | 'workspaceKind'
  | 'isArchived'
  | 'parentWorktreeId'
  | 'worktreeInstanceId'
  | 'lineageWorktreeInstanceId'
  | 'parentWorktreeInstanceId'
  | 'crossStoreParent'
  | 'workspaceLineage'
>

function hasValidLineageParent(worktree: MobileLineageRow, parent: MobileLineageRow): boolean {
  if (
    worktree.lineageWorktreeInstanceId === undefined &&
    worktree.parentWorktreeInstanceId === undefined
  ) {
    return true
  }
  // Match desktop’s instance guard so path reuse cannot attach a new workspace to stale lineage.
  return (
    worktree.worktreeInstanceId === worktree.lineageWorktreeInstanceId &&
    parent.worktreeInstanceId === worktree.parentWorktreeInstanceId
  )
}

/** The stores a host's list spans, by the identities the host checked: its own (its status
 * descriptor) and each server it relays (its verified descriptor). */
export type MobileLineageStores = {
  ownInstallationId: string | undefined
  servers: readonly Pick<MobileRelayHost, 'hostId' | 'installationId'>[]
}

type ResolutionRow<Row extends MobileLineageRow = MobileLineageRow> = {
  worktree: Row
  id: string
  hostId: ExecutionHostId
  instanceId: string | undefined
  isArchived: boolean
}

function getResolutionRows<Row extends MobileLineageRow>(
  worktrees: readonly Row[]
): Map<string, ResolutionRow<Row>> {
  return new Map(
    worktrees.map((worktree) => [
      getWorktreeRowIdentity(worktree),
      {
        worktree,
        id: worktree.worktreeId,
        // Rows the host lists without a host id are its own: only relayed server rows name one.
        hostId: worktree.hostId ?? LOCAL_EXECUTION_HOST_ID,
        instanceId: worktree.worktreeInstanceId,
        isArchived: worktree.isArchived === true
      }
    ])
  )
}

// Unchecked wire data: a newer host may send a shape this build cannot read.
function readFolderEdge(worktree: MobileLineageRow): WorkspaceLineageEdge | undefined {
  const edge = worktree.workspaceLineage
  return edge && typeof edge.parentWorkspaceKey === 'string' ? edge : undefined
}

/** The stores' identities a cross-store record is checked against, or none without a record. */
function getCrossStoreView(
  rows: ReadonlyMap<string, ResolutionRow>,
  stores: MobileLineageStores | undefined
): CrossStoreLineageView | undefined {
  if (!stores || ![...rows.values()].some((row) => row.worktree.crossStoreParent)) {
    return undefined
  }
  const installationIds = new Map<string, string | undefined>([
    [OWN_LINEAGE_STORE_KEY, stores.ownInstallationId]
  ])
  for (const server of stores.servers) {
    const parsed = parseExecutionHostId(server.hostId)
    if (parsed?.kind === 'runtime') {
      installationIds.set(parsed.environmentId, server.installationId)
    }
  }
  return buildCrossStoreLineageViewOfRows(
    rows.values(),
    (row) => row.worktree.crossStoreParent,
    installationIds
  )
}

/** Children keyed by parent row identity, over valid edges between the given rows: a worktree parent,
 * else a folder workspace parent in the child's store, else (with `stores`) a parent on another
 * machine; lineage loops nest nothing.
 * Edges resolve over every row, then `filterRepoIds` keeps those with both ends shown: a hidden
 * twin must still make a parent ambiguous. */
export function getMobileWorkspaceLineageChildren<Row extends MobileLineageRow>(
  listed: readonly Row[],
  stores?: MobileLineageStores,
  filterRepoIds: readonly string[] = []
): Map<string, Row[]> {
  const rows = getResolutionRows(listed)
  // The shared policy: worktree parent, then folder workspace, then another store. The phone trusts
  // an older host's edge without instance ids and keeps its loops, as it always has.
  const resolved = resolveLineageParentsByPolicy(rows, {
    sameStoreParentOf: (row) => {
      const parentId = row.worktree.parentWorktreeId
      const parent = parentId
        ? rows.get(getWorktreeRowIdentity({ worktreeId: parentId, hostId: row.worktree.hostId }))
        : undefined
      return parent && parent !== row && hasValidLineageParent(row.worktree, parent.worktree)
        ? parent
        : undefined
    },
    crossStoreLineage: getCrossStoreView(rows, stores),
    folderRecordOf: (row) => readFolderEdge(row.worktree),
    keepSameStoreCycles: true
  })
  const parentByChild = new Map([...resolved].map(([child, parent]) => [child, parent.worktree]))
  const shown = (row: Row): boolean =>
    filterRepoIds.length === 0 || filterRepoIds.includes(row.repoId)
  const childrenByParentId = new Map<string, Row[]>()
  for (const worktree of listed) {
    const parent = parentByChild.get(getWorktreeRowIdentity(worktree))
    // A folder workspace spans projects, so the project filter never hides it as a parent.
    if (
      !parent ||
      !shown(worktree) ||
      (!shown(parent) && parent.workspaceKind !== 'folder-workspace')
    ) {
      continue
    }
    const parentIdentity = getWorktreeRowIdentity(parent)
    const children = childrenByParentId.get(parentIdentity) ?? []
    children.push(worktree)
    childrenByParentId.set(parentIdentity, children)
  }
  return childrenByParentId
}

export function getMobileOccurrenceRows(
  plan: WorktreeOccurrencePlan<Worktree>,
  sectionKey: string,
  collapsedGroups: ReadonlySet<string>,
  hostContextOf: WorktreeHostContextOf = NO_WORKTREE_HOST_CONTEXT
): WorkspaceListItem[] {
  return getExpandedWorktreeOccurrences(plan.bySection.get(sectionKey) ?? [], (worktree) =>
    collapsedGroups.has(getMobileWorkspaceLineageGroupKey(worktree))
  ).map((occurrence) => ({
    row: occurrence.row,
    view: {
      ...hostContextOf(occurrence.row),
      sectionListKey: occurrence.key,
      lineageDepth: occurrence.depth,
      lineageChildCount: occurrence.childCount,
      lineageCollapsed:
        occurrence.childCount > 0 &&
        collapsedGroups.has(getMobileWorkspaceLineageGroupKey(occurrence.row)),
      isLastLineageChild: occurrence.isLastChild,
      showProjectName: occurrence.showProjectName
    }
  }))
}

export function applyMobileWorkspaceLineage(
  worktrees: readonly Worktree[],
  collapsedGroups: ReadonlySet<string> = new Set()
): WorkspaceListItem[] {
  const plan = buildWorktreeOccurrencePlan({
    rows: worktrees,
    childrenByParentIdentity: getMobileWorkspaceLineageChildren(worktrees),
    identityOf: getWorktreeRowIdentity,
    isPinned: () => false,
    duplicatePinned: false,
    sectionsOf: () => [{ key: 'all', items: worktrees }],
    projectIdOf: (worktree) => worktree.repoId
  })
  return getMobileOccurrenceRows(plan, 'all', collapsedGroups)
}
