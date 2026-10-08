import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'

// The two terminal-layout invariants: a terminal is bound to at most one leaf, and a leaf id is in
// at most one tab. The binding write reports breaches; nothing removes them yet.

export type TerminalSessionPartition = { hostId: ExecutionHostId; session: WorkspaceSessionState }

export type TerminalLeafOwner = {
  hostId: ExecutionHostId
  worktreeId: string
  tab: TerminalTab
  leafId: string
  ptyId: string | undefined
  incarnationId: string | undefined
  /** Tree order across the partition, for deterministic tie-breaks. */
  order: number
}

export type TerminalOwnerConflictReason =
  | 'pty_bound_to_other_leaf'
  | 'leaf_in_other_tab'
  // Kept apart: older relay reattaches left SSH panes in `local`, so this may be one moved surface.
  | 'leaf_in_other_tab_on_other_host'

/** `runtime:` partitions belong to a remote Orca server and are written only by its tab sync. */
export function isTerminalOwnerPartition(hostId: ExecutionHostId): boolean {
  const kind = parseExecutionHostId(hostId)?.kind
  return kind === 'local' || kind === 'ssh'
}

/** Every leaf of every tab row; a layout left behind by a removed tab row owns nothing. */
export function collectTerminalLeafOwners({
  hostId,
  session
}: TerminalSessionPartition): TerminalLeafOwner[] {
  const owners: TerminalLeafOwner[] = []
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      const layout = session.terminalLayoutsByTabId?.[tab.id]
      for (const leafId of collectLayoutLeafIdsInOrder(layout?.root)) {
        owners.push({
          hostId,
          worktreeId,
          tab,
          leafId,
          ptyId: layout?.ptyIdsByLeafId?.[leafId],
          incarnationId: session.terminalPtyIncarnationsByPaneKey?.[`${tab.id}:${leafId}`],
          order: owners.length
        })
      }
    }
  }
  return owners
}

/** Relay ids like `pty-1` repeat across relay restarts, so without an incarnation they prove nothing. */
function isRepeatingRelayPtyId(ptyId: string): boolean {
  const relayPtyId = parseAppSshPtyId(ptyId)?.relayPtyId
  return relayPtyId !== undefined && /^pty-\d+$/.test(relayPtyId)
}

/**
 * One terminal is one PTY incarnation; with either incarnation unrecorded, the PTY id alone,
 * unless it is a repeating relay id.
 */
export function isSameTerminal(
  left: { ptyId: string | undefined; incarnationId?: string },
  right: { ptyId: string | undefined; incarnationId?: string }
): boolean {
  if (left.ptyId === undefined || left.ptyId !== right.ptyId) {
    return false
  }
  if (left.incarnationId !== undefined && right.incarnationId !== undefined) {
    return left.incarnationId === right.incarnationId
  }
  return !isRepeatingRelayPtyId(left.ptyId)
}

/**
 * The saved leaf a binding into `hostId` would duplicate, if any. The same tab:leaf in two
 * partitions is one surface: older relay reattaches left SSH panes in `local`.
 */
export function findTerminalBindingConflict(
  binding: { tabId: string; leafId: string; ptyId: string; incarnationId?: string },
  hostId: ExecutionHostId,
  partitions: readonly TerminalSessionPartition[]
): { reason: TerminalOwnerConflictReason; owner: TerminalLeafOwner } | null {
  // Legacy leaf ids are never written into leaf-keyed layout state, so they cannot own a terminal.
  if (!isTerminalLeafId(binding.leafId)) {
    return null
  }
  for (const partition of partitions) {
    if (!isTerminalOwnerPartition(partition.hostId)) {
      continue
    }
    for (const owner of collectTerminalLeafOwners(partition)) {
      if (owner.leafId === binding.leafId) {
        if (owner.tab.id !== binding.tabId) {
          const reason =
            partition.hostId === hostId ? 'leaf_in_other_tab' : 'leaf_in_other_tab_on_other_host'
          return { reason, owner }
        }
      } else if (isSameTerminal(owner, binding)) {
        return { reason: 'pty_bound_to_other_leaf', owner }
      }
    }
  }
  return null
}
