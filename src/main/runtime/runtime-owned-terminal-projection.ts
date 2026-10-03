import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncWindowGraph
} from '../../shared/runtime-types'
import { isTerminalLeafId } from '../../shared/stable-pane-id'

/** The surface a retention decision is about; all three must match for the host to keep its PTY. */
export type RuntimePaneIdentity = {
  paneKey: string
  worktreeId: string
  tabId: string
}

export function makeRuntimePaneIdentity(
  leaf: { worktreeId: string; tabId: string },
  paneKey: string
): RuntimePaneIdentity {
  return { paneKey, worktreeId: leaf.worktreeId, tabId: leaf.tabId }
}

/** Resolves the host-owned PTY a pane may keep, or null when nothing may be retained. */
export type RuntimeOwnedPtyResolver = (
  pane: RuntimePaneIdentity,
  currentPtyId: string | null
) => string | null

export function collectRendererPublishedEmptyTerminalPanes(
  graph: Pick<RuntimeSyncWindowGraph, 'mobileSessionTabs' | 'unchangedMobileSessionWorktrees'>,
  snapshots: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>,
  acceptedSnapshots: ReadonlyMap<string, { rendererTabIdentityKeys: ReadonlySet<string> }>
): { emptyPaneWorktrees: Map<string, string>; boundPtyIds: Set<string> } {
  const worktrees = new Set([
    ...(graph.mobileSessionTabs?.map((snapshot) => snapshot.worktree) ?? []),
    ...(graph.unchangedMobileSessionWorktrees ?? [])
  ])
  const emptyPaneWorktrees = new Map<string, string>()
  const boundPtyIds = new Set<string>()
  for (const worktreeId of worktrees) {
    const accepted = acceptedSnapshots.get(worktreeId)
    for (const tab of snapshots.get(worktreeId)?.tabs ?? []) {
      // Host-preserved tabs cannot stand in for a pane the renderer actually published.
      if (
        tab.type !== 'terminal' ||
        !accepted?.rendererTabIdentityKeys.has(`${tab.parentTabId}::${tab.leafId}`)
      ) {
        continue
      }
      if (tab.ptyId) {
        boundPtyIds.add(tab.ptyId)
      } else if (isTerminalLeafId(tab.leafId)) {
        emptyPaneWorktrees.set(`${tab.parentTabId}::${tab.leafId}`, worktreeId)
      }
    }
  }
  return { emptyPaneWorktrees, boundPtyIds }
}

function indexRuntimeOwnedPanePtys(
  ptys: Iterable<RuntimePtyWorktreeRecord>,
  isExited: (ptyId: string) => boolean
): Map<string, RuntimePtyWorktreeRecord | null> {
  const owners = new Map<string, RuntimePtyWorktreeRecord | null>()
  for (const pty of ptys) {
    if (!pty.runtimeSessionOwned || !pty.paneKey || isExited(pty.ptyId)) {
      continue
    }
    // Ambiguous host ownership cannot authorize choosing either process.
    owners.set(pty.paneKey, owners.has(pty.paneKey) ? null : pty)
  }
  return owners
}

export function createRuntimeOwnedPtyResolver(
  ptys: Iterable<RuntimePtyWorktreeRecord>,
  isExited: (ptyId: string) => boolean,
  incomingPtyIds: ReadonlySet<string>
): RuntimeOwnedPtyResolver {
  const hostOwnedPtys = indexRuntimeOwnedPanePtys(ptys, isExited)
  return (pane, currentPtyId) => {
    const pty = hostOwnedPtys.get(pane.paneKey)
    // A pane claimed elsewhere in this graph, or already bound to a different PTY, is not retainable.
    return pty?.worktreeId === pane.worktreeId &&
      pty.tabId === pane.tabId &&
      (!currentPtyId || currentPtyId === pty.ptyId) &&
      !incomingPtyIds.has(pty.ptyId)
      ? pty.ptyId
      : null
  }
}

export function chooseProjectedPtyId(
  incomingPtyId: string | null,
  existingPtyId: string | null | undefined,
  preserveReload: boolean,
  pane: RuntimePaneIdentity,
  resolver: RuntimeOwnedPtyResolver
): string | null {
  if (incomingPtyId) {
    return incomingPtyId
  }
  const owned = resolver(pane, null)
  if (owned && (!existingPtyId || existingPtyId === owned)) {
    return owned
  }
  return preserveReload ? (existingPtyId ?? null) : null
}

export function shouldPreservePublishedRuntimePane(
  pane: RuntimePaneIdentity,
  ptyId: string,
  publishedWorktree: string | undefined,
  publishedPtyIds: ReadonlySet<string>,
  resolver: RuntimeOwnedPtyResolver
): boolean {
  return (
    publishedWorktree === pane.worktreeId &&
    !publishedPtyIds.has(ptyId) &&
    resolver(pane, ptyId) !== null
  )
}
