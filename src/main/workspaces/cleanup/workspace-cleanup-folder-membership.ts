// Which worktrees one folder workspace lists, so cleanup removes them together or not at all (#44715).
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { isWorktreeRetiredByRemoval } from '../../../shared/worktree/removal/removal-visibility'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../shared/workspace/identity/workspace-scope'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import type { RuntimeWorktreePsSummary } from '../../../shared/worktree/catalog/runtime-worktree-contracts'
import {
  isOrchestrationLineage,
  isUngroupedCrossStoreLineage,
  type PairedFolderChildren
} from './workspace-cleanup-paired-folder-children'

export function summaryHostId(summary: RuntimeWorktreePsSummary): ExecutionHostId | null {
  return summary.hostId ? normalizeExecutionHostId(summary.hostId) : LOCAL_EXECUTION_HOST_ID
}

/** A same-id row on another host is a different checkout. */
export function summaryIdentity(summary: RuntimeWorktreePsSummary): string {
  return composeWorktreeHostIdentity(summaryHostId(summary) ?? undefined, summary.worktreeId)
}

const EMPTY_SIBLINGS: readonly string[] = []
const EMPTY_HELD_FOLDERS: ReadonlySet<string> = new Set()

export type FolderMembershipIndex = {
  siblingsOf: (summary: RuntimeWorktreePsSummary) => readonly string[]
  localFolderKeyOf: (summary: RuntimeWorktreePsSummary) => string | null
  findPairedHeldFolders: (
    candidateFolderKeys: ReadonlySet<string>,
    readPairedFolderChildren: () => Promise<PairedFolderChildren>
  ) => Promise<ReadonlySet<string>>
}

/** Each listed worktree's folder siblings by host identity: the others its folder workspace's Source
 * Control lists, attached worktrees and their lineage children alike, on any host. A bot's home is
 * not one piece of work, so its workspaces stay independent.
 *
 * A parent in another Orca store keeps that link only in the child's store, so each side sees half:
 * a child here whose parent is elsewhere may be in a folder there, so it is held (workers and bot
 * hand-overs aside), and this host's folders learn of children in paired servers' stores lazily via
 * `findPairedHeldFolders` only when a local folder actually has a removable member. */
export function buildFolderMembership(
  store: RuntimeStore,
  summaries: readonly RuntimeWorktreePsSummary[]
): FolderMembershipIndex {
  const botHomes = new Set(
    (store.getBots?.() ?? []).map((bot) => folderWorkspaceKey(bot.folderWorkspaceId))
  )
  const folderEdges = store.getAllWorkspaceLineage?.() ?? {}
  const parentEdges = store.getAllWorktreeLineage?.() ?? {}
  const crossStoreEdges = store.getAllCrossStoreWorkspaceLineage?.() ?? {}
  const rows = summaries.filter((summary) => summary.workspaceKind !== 'folder-workspace')
  const byIdentity = new Map(rows.map((row) => [summaryIdentity(row), row]))
  // A listed row speaks for itself; one the listing lacks (its repo's scan failed) is read from its stored lineage.
  const folderOf = (hostId: ExecutionHostId | undefined, worktreeId: string): string | null => {
    const seen = new Set<string>()
    let worker = false
    for (let id: string | null = worktreeId; id !== null && !seen.has(id);) {
      seen.add(id)
      const edge = parentEdges[id]
      worker ||= edge !== undefined && isOrchestrationLineage(edge)
      const row = byIdentity.get(composeWorktreeHostIdentity(hostId, id))
      // An archived ancestor hides its subtree from the folder.
      if (row?.isArchived) {
        return null
      }
      const folderKey = row
        ? row.workspaceLineage?.parentWorkspaceKey
        : folderEdges[worktreeWorkspaceKey(id)]?.parentWorkspaceKey
      if (folderKey) {
        return botHomes.has(folderKey) ? null : folderKey
      }
      const elsewhere = row ? row.crossStoreParent : crossStoreEdges[worktreeWorkspaceKey(id)]
      if (elsewhere) {
        return worker || isUngroupedCrossStoreLineage(elsewhere)
          ? null
          : `${elsewhere.parent.installationId}|${elsewhere.parent.workspaceKey}`
      }
      id = row ? row.parentWorktreeId : (edge?.parentWorktreeId ?? null)
    }
    return null
  }
  const folderByMember = new Map<RuntimeWorktreePsSummary, string>()
  const membersByFolder = new Map<string, string[]>()
  const join = (folderKey: string, identity: string): void => {
    const members = membersByFolder.get(folderKey) ?? []
    members.push(identity)
    membersByFolder.set(folderKey, members)
  }
  for (const row of rows) {
    // A row retired by removal is leaving; its children still list under the folder.
    const folderKey = isWorktreeRetiredByRemoval(row)
      ? null
      : folderOf(summaryHostId(row) ?? undefined, row.worktreeId)
    if (folderKey) {
      folderByMember.set(row, folderKey)
      join(folderKey, summaryIdentity(row))
    }
  }
  // A recorded worktree no listed row stands for has no verdict here, so it holds its folder's group.
  const recorded = new Map<string, string | null | undefined>()
  for (const edge of Object.values(folderEdges)) {
    const child = parseWorkspaceKey(edge.childWorkspaceKey)
    if (child?.type === 'worktree') {
      recorded.set(child.worktreeId, edge.childInstanceId)
    }
  }
  for (const [worktreeId, lineage] of Object.entries(parentEdges)) {
    if (!recorded.has(worktreeId)) {
      recorded.set(worktreeId, lineage.worktreeInstanceId)
    }
  }
  const rowsById = Map.groupBy(rows, (row) => row.worktreeId)
  for (const [worktreeId, instanceId] of recorded) {
    const listed = rowsById
      .get(worktreeId)
      ?.some(
        (row) => !instanceId || !row.worktreeInstanceId || row.worktreeInstanceId === instanceId
      )
    // An archived checkout is gone from disk on purpose, so it has nothing to hold.
    const archived = store.getWorktreeMeta(worktreeId)?.archivedCheckout
    const folderKey = listed || archived ? null : folderOf(undefined, worktreeId)
    if (folderKey && membersByFolder.has(folderKey)) {
      join(folderKey, composeWorktreeHostIdentity(undefined, worktreeId))
    }
  }
  for (const key of membersByFolder.keys()) {
    if (!key.startsWith('folder:')) {
      // The folder's other members are in its own store, which this host can't read.
      join(key, `?|${key}`)
    }
  }
  let byInstance: Map<string | undefined, RuntimeWorktreePsSummary> | null = null
  return {
    // Share the folder's member list directly so K members don't allocate K copies of size K-1.
    siblingsOf: (summary) => {
      const folderKey = folderByMember.get(summary)
      const members = folderKey ? membersByFolder.get(folderKey) : undefined
      return members && members.length > 1 ? members : EMPTY_SIBLINGS
    },
    localFolderKeyOf: (summary) => {
      const folderKey = folderByMember.get(summary)
      return folderKey && folderKey.startsWith('folder:') ? folderKey : null
    },
    findPairedHeldFolders: async (candidateFolderKeys, readPairedFolderChildren) => {
      if (candidateFolderKeys.size === 0) {
        return EMPTY_HELD_FOLDERS
      }
      const paired = await readPairedFolderChildren()
      if (!paired.complete) {
        // A server that didn't answer (or wasn't connected) may hold a member of any candidate folder.
        return candidateFolderKeys
      }
      if (paired.children.length === 0) {
        return EMPTY_HELD_FOLDERS
      }
      // A renamed or moved parent keeps its instance, while the child's ref keeps its old key.
      byInstance ??= new Map(rows.map((row) => [row.worktreeInstanceId, row]))
      const held = new Set<string>()
      for (const { parentWorkspaceKey, parentInstanceId } of paired.children) {
        const parent = parseWorkspaceKey(parentWorkspaceKey)
        const parentRow = byInstance.get(parentInstanceId)
        const folderKey =
          parent?.type !== 'worktree'
            ? parentWorkspaceKey
            : parentRow
              ? folderOf(summaryHostId(parentRow) ?? undefined, parentRow.worktreeId)
              : folderOf(undefined, parent.worktreeId)
        if (folderKey && candidateFolderKeys.has(folderKey)) {
          held.add(folderKey)
        }
      }
      return held
    }
  }
}

/** The target, then this host's workspaces in its folder now. */
export function folderGroupOf(
  owned: readonly RuntimeWorktreePsSummary[],
  worktreeId: string,
  folderSiblingsOf: (summary: RuntimeWorktreePsSummary) => readonly string[]
): RuntimeWorktreePsSummary[] {
  const target = owned.find((summary) => summary.worktreeId === worktreeId)
  if (!target) {
    return []
  }
  const targetId = summaryIdentity(target)
  const siblings = new Set(folderSiblingsOf(target))
  return [
    target,
    ...owned.filter((summary) => {
      const id = summaryIdentity(summary)
      return id !== targetId && siblings.has(id)
    })
  ]
}

/** Every owned workspace currently in the given local folder. */
export function folderGroupByKey(
  owned: readonly RuntimeWorktreePsSummary[],
  localFolderKey: string,
  localFolderKeyOf: (summary: RuntimeWorktreePsSummary) => string | null
): RuntimeWorktreePsSummary[] {
  return owned.filter((summary) => localFolderKeyOf(summary) === localFolderKey)
}
