// Which worktrees one folder workspace lists, so cleanup removes them together or not at all (#44715).
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { isWorktreeRetiredByRemoval } from '../../../shared/worktree/removal/removal-visibility'
import {
  folderWorkspaceKey,
  parseWorkspaceKey
} from '../../../shared/workspace/identity/workspace-scope'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import type { RuntimeWorktreePsSummary } from '../../../shared/worktree/catalog/runtime-worktree-contracts'

export function summaryHostId(summary: RuntimeWorktreePsSummary): ExecutionHostId | null {
  return summary.hostId ? normalizeExecutionHostId(summary.hostId) : LOCAL_EXECUTION_HOST_ID
}

/** A same-id row on another host is a different checkout. */
export function summaryIdentity(summary: RuntimeWorktreePsSummary): string {
  return composeWorktreeHostIdentity(summaryHostId(summary) ?? undefined, summary.worktreeId)
}

/** Each listed worktree's folder siblings by host identity: the others its folder workspace's Source
 * Control lists, attached worktrees and their lineage children alike, on any host. A bot's home is
 * not one piece of work, so its workspaces stay independent. */
export function folderSiblingsByWorktree(
  store: RuntimeStore,
  summaries: readonly RuntimeWorktreePsSummary[]
): (summary: RuntimeWorktreePsSummary) => string[] {
  const botHomes = new Set(
    (store.getBots?.() ?? []).map((bot) => folderWorkspaceKey(bot.folderWorkspaceId))
  )
  const byIdentity = new Map(summaries.map((summary) => [summaryIdentity(summary), summary]))
  // An archived ancestor hides its subtree from the folder; a retired one passes its children up.
  const folderOf = (summary: RuntimeWorktreePsSummary): string | null => {
    const visited = new Set<RuntimeWorktreePsSummary>()
    let row: RuntimeWorktreePsSummary | undefined = summary
    while (row && !row.isArchived && !visited.has(row)) {
      if (row.workspaceLineage) {
        const folderKey = row.workspaceLineage.parentWorkspaceKey
        return botHomes.has(folderKey) ? null : folderKey
      }
      visited.add(row)
      row = row.parentWorktreeId
        ? byIdentity.get(
            composeWorktreeHostIdentity(summaryHostId(row) ?? undefined, row.parentWorktreeId)
          )
        : undefined
    }
    return null
  }
  const folderByMember = new Map<RuntimeWorktreePsSummary, string>()
  const membersByFolder = new Map<string, string[]>()
  for (const summary of summaries) {
    const folderKey =
      summary.workspaceKind === 'folder-workspace' || isWorktreeRetiredByRemoval(summary)
        ? null
        : folderOf(summary)
    if (folderKey) {
      folderByMember.set(summary, folderKey)
      const members = membersByFolder.get(folderKey) ?? []
      members.push(summaryIdentity(summary))
      membersByFolder.set(folderKey, members)
    }
  }
  // A child the folder records but the listing lacks (its repo's scan failed) has no verdict, so it holds the group.
  const listed = new Set(summaries.map((summary) => summary.worktreeId))
  for (const edge of Object.values(store.getAllWorkspaceLineage?.() ?? {})) {
    const child = parseWorkspaceKey(edge.childWorkspaceKey)
    const members = membersByFolder.get(edge.parentWorkspaceKey)
    if (members && child?.type === 'worktree' && !listed.has(child.worktreeId)) {
      members.push(composeWorktreeHostIdentity(undefined, child.worktreeId))
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
