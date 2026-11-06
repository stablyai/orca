import {
  buildWorktreeOccurrencePlan,
  getExpandedWorktreeOccurrences,
  type WorktreeOccurrencePlan
} from '../../../src/shared/worktree-occurrence-plan'
import type { WorkspaceListItem, Worktree } from './workspace-list-types'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../src/shared/execution-host'
import { getCyclicLineageChildKeys } from '../../../src/shared/resolved-worktree-lineage'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import {
  buildCrossStoreLineageViewOfRows,
  OWN_LINEAGE_STORE_KEY,
  resolveCrossStoreLineageParents
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

function hasValidLineageParent(worktree: Worktree, parent: Worktree): boolean {
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

/** Child identity → parent row for each server-saved cross-store record that resolves to one row. */
function getCrossStoreLineageParents(
  worktrees: readonly Worktree[],
  stores: MobileLineageStores
): Map<string, Worktree> {
  const resolutionRows = new Map(
    worktrees.map((worktree) => [
      getWorktreeRowIdentity(worktree),
      {
        worktree,
        id: worktree.worktreeId,
        // Rows the host lists without a host id are its own: only relayed server rows name one.
        hostId: worktree.hostId ?? LOCAL_EXECUTION_HOST_ID,
        instanceId: worktree.worktreeInstanceId
      }
    ])
  )
  if (![...resolutionRows.values()].some((row) => row.worktree.crossStoreParent)) {
    return new Map()
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
  const view = buildCrossStoreLineageViewOfRows(
    resolutionRows.values(),
    (row) => row.worktree.crossStoreParent,
    installationIds
  )
  return new Map(
    [...resolveCrossStoreLineageParents(resolutionRows, view)].map(([child, parent]) => [
      child,
      parent.worktree
    ])
  )
}

/** Children keyed by parent row identity, over valid edges between the given rows; with `stores`,
 * a parent on another machine counts too (a same-store edge wins), and lineage loops nest nothing.
 * Edges resolve over every row, then `filterRepoIds` keeps those with both ends shown: a hidden
 * twin must still make a parent ambiguous. */
export function getMobileWorkspaceLineageChildren(
  listed: readonly Worktree[],
  stores?: MobileLineageStores,
  filterRepoIds: readonly string[] = []
): Map<string, Worktree[]> {
  const worktreeById = new Map(
    listed.map((worktree) => [getWorktreeRowIdentity(worktree), worktree])
  )
  const parentByChild = new Map<string, Worktree>()

  for (const worktree of listed) {
    const worktreeId = getWorktreeRowIdentity(worktree)
    const parentId = worktree.parentWorktreeId
    const parentIdentity = parentId
      ? getWorktreeRowIdentity({ worktreeId: parentId, hostId: worktree.hostId })
      : null
    const parent = parentIdentity ? worktreeById.get(parentIdentity) : undefined
    if (
      !parentIdentity ||
      parentIdentity === worktreeId ||
      !parent ||
      !hasValidLineageParent(worktree, parent)
    ) {
      continue
    }
    parentByChild.set(worktreeId, parent)
  }
  const crossStore = stores ? getCrossStoreLineageParents(listed, stores) : new Map()
  if (crossStore.size > 0) {
    for (const [child, parent] of crossStore) {
      if (!parentByChild.has(child)) {
        parentByChild.set(child, parent)
      }
    }
    const cyclic = getCyclicLineageChildKeys(
      new Map([...parentByChild].map(([child, parent]) => [child, getWorktreeRowIdentity(parent)]))
    )
    for (const child of cyclic) {
      parentByChild.delete(child)
    }
  }
  const shown = (row: Worktree): boolean =>
    filterRepoIds.length === 0 || filterRepoIds.includes(row.repoId)
  const childrenByParentId = new Map<string, Worktree[]>()
  for (const worktree of listed) {
    const parent = parentByChild.get(getWorktreeRowIdentity(worktree))
    if (!parent || !shown(worktree) || !shown(parent)) {
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
