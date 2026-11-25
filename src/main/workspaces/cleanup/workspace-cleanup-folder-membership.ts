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

/** Each listed worktree's folder siblings by host identity: the others its folder workspace's Source
 * Control lists, attached worktrees and their lineage children alike, on any host. A bot's home is
 * not one piece of work, so its workspaces stay independent.
 *
 * A parent in another Orca store keeps that link only in the child's store, so each side sees half:
 * a child here whose parent is elsewhere may be in a folder there, so it is held (workers and bot
 * hand-overs aside), and this host's folders learn of children in paired servers' stores from
 * `readPairedFolderChildren`. A headless server can't reach the other servers its clients pair, so
 * children elsewhere of its own folders stay unseen. */
export async function folderSiblingsByWorktree(
  store: RuntimeStore,
  summaries: readonly RuntimeWorktreePsSummary[],
  readPairedFolderChildren?: () => Promise<PairedFolderChildren>
): Promise<(summary: RuntimeWorktreePsSummary) => string[]> {
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
  const localFolders = [...membersByFolder.keys()].filter((key) => key.startsWith('folder:'))
  for (const key of membersByFolder.keys()) {
    if (!key.startsWith('folder:')) {
      // The folder's other members are in its own store, which this host can't read.
      join(key, `?|${key}`)
    }
  }
  if (localFolders.length > 0 && readPairedFolderChildren) {
    const paired = await readPairedFolderChildren()
    // A renamed or moved parent keeps its instance, while the child's ref keeps its old key.
    const byInstance = new Map(rows.map((row) => [row.worktreeInstanceId, row]))
    for (const { identity, parentWorkspaceKey, parentInstanceId } of paired.children) {
      const parent = parseWorkspaceKey(parentWorkspaceKey)
      const parentRow = byInstance.get(parentInstanceId)
      const folderKey =
        parent?.type !== 'worktree'
          ? parentWorkspaceKey
          : parentRow
            ? folderOf(summaryHostId(parentRow) ?? undefined, parentRow.worktreeId)
            : folderOf(undefined, parent.worktreeId)
      if (folderKey && membersByFolder.has(folderKey)) {
        join(folderKey, identity)
      }
    }
    if (!paired.complete) {
      // A server that didn't answer may hold a member of any of them.
      for (const key of localFolders) {
        join(key, '?|unanswered')
      }
    }
  }
  return (summary) => {
    const folderKey = folderByMember.get(summary)
    const self = summaryIdentity(summary)
    return folderKey ? membersByFolder.get(folderKey)!.filter((id) => id !== self) : []
  }
}

/** The target, then this host's workspaces in its folder now. */
export function folderGroupOf(
  owned: readonly RuntimeWorktreePsSummary[],
  worktreeId: string,
  folderSiblingsOf: (summary: RuntimeWorktreePsSummary) => string[]
): RuntimeWorktreePsSummary[] {
  const target = owned.find((summary) => summary.worktreeId === worktreeId)
  if (!target) {
    return []
  }
  const siblings = new Set(folderSiblingsOf(target))
  return [target, ...owned.filter((summary) => siblings.has(summaryIdentity(summary)))]
}

/** Whether a listed workspace's folder has a member the listing lacks. */
export function hasUnlistedFolderSibling(
  listed: readonly RuntimeWorktreePsSummary[],
  folderSiblingsOf: (summary: RuntimeWorktreePsSummary) => string[]
): boolean {
  const identities = new Set(listed.map(summaryIdentity))
  return listed.some((summary) => folderSiblingsOf(summary).some((id) => !identities.has(id)))
}

/** A project's workspaces, then other projects' worktrees in the same folder workspaces. */
export function projectFolderGroups(
  owned: readonly RuntimeWorktreePsSummary[],
  projectId: string,
  folderSiblingsOf: (summary: RuntimeWorktreePsSummary) => string[]
): RuntimeWorktreePsSummary[] {
  const project = owned.filter((summary) => summary.repoId === projectId)
  const siblings = new Set(project.flatMap(folderSiblingsOf))
  return [
    ...project,
    ...owned.filter(
      (summary) => summary.repoId !== projectId && siblings.has(summaryIdentity(summary))
    )
  ]
}
