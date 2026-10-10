import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab,
  RuntimeSessionTabCloseReason,
  RuntimeSyncedTab
} from '../../shared/runtime-types'
import type { MobileSessionTabCloseOutcome } from './mobile-session-tab-close-outcome'
import {
  delegatedMobileSessionTabClose,
  refusedMobileSessionTabClose
} from './mobile-session-tab-close-outcome'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { worktreeIdsEqual } from '../../shared/worktree/id'

export type MobileSessionLifecycleCloseHost = {
  tabs: ReadonlyMap<string, RuntimeSyncedTab>
  leaves: ReadonlyMap<string, RuntimeLeafRecord>
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  findPtyForMobileTerminalTab: (
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ) => RuntimePtyWorktreeRecord | null
  republishSnapshot: (worktreeId: string) => void
}

/** Everything a close needs about the surface the request addresses, including one already retired. */
export type MobileSessionLifecycleCloseContext = {
  closeParentTabId: string | null
  closeLeafId: string | null
  parentLeaves: RuntimeMobileSessionTerminalTab[]
  rendererLeaves: RuntimeLeafRecord[]
  leafHasConnectedPty: (leaf: RuntimeMobileSessionTerminalTab) => boolean
  rendererLeafHasConnectedPty: (leaf: RuntimeLeafRecord) => boolean
}

export function resolveMobileSessionLifecycleCloseContext(args: {
  host: MobileSessionLifecycleCloseHost
  worktreeId: string
  tabId: string
  tab: RuntimeMobileSessionSnapshotTab | undefined
  authorityTab: RuntimeMobileSessionSnapshotTab | undefined
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined
  observedPtyIds: ReadonlySet<string> | null
}): MobileSessionLifecycleCloseContext {
  const { host, worktreeId, tabId, tab, authorityTab, snapshot, observedPtyIds } = args
  const closeParentTabId =
    tab?.type === 'terminal'
      ? tab.parentTabId
      : authorityTab?.type === 'terminal'
        ? authorityTab.parentTabId
        : host.tabs.has(tabId)
          ? tabId
          : ([...host.tabs.keys()]
              .filter((parentTabId) => tabId.startsWith(`${parentTabId}::`))
              .sort((a, b) => b.length - a.length)[0] ??
            (
              snapshot?.tabs.find(
                (candidate) =>
                  candidate.type === 'terminal' && tabId.startsWith(`${candidate.parentTabId}::`)
              ) as RuntimeMobileSessionTerminalTab | undefined
            )?.parentTabId ??
            null)
  const parentLeaves = closeParentTabId
    ? (snapshot?.tabs.filter(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' && candidate.parentTabId === closeParentTabId
      ) ?? [])
    : []
  const rendererLeaves = closeParentTabId
    ? [...host.leaves.values()].filter(
        (leaf) => leaf.tabId === closeParentTabId && worktreeIdsEqual(leaf.worktreeId, worktreeId)
      )
    : []
  return {
    closeParentTabId,
    closeLeafId:
      closeParentTabId && tabId.startsWith(`${closeParentTabId}::`)
        ? tabId.slice(closeParentTabId.length + 2)
        : null,
    parentLeaves,
    rendererLeaves,
    // Why: exited PTYs keep a disconnected record for status reads, so record
    // presence is not liveness — only `connected`, or a genuinely dead tab
    // never retires and the echo loops forever. Daemon discovery can still
    // prove a PTY live before its pane binding reconnects.
    leafHasConnectedPty: (leaf) => {
      const snapshotPtyIds = [leaf.ptyId, leaf.parentLayout?.ptyIdsByLeafId?.[leaf.leafId]].filter(
        (ptyId): ptyId is string => Boolean(ptyId)
      )
      return (
        host.findPtyForMobileTerminalTab(worktreeId, leaf)?.connected === true ||
        snapshotPtyIds.some((ptyId) => observedPtyIds?.has(ptyId) === true)
      )
    },
    rendererLeafHasConnectedPty: (leaf) => {
      const ptyId = leaf.ptyId
      return Boolean(
        ptyId &&
        (host.ptysById.get(ptyId)?.connected === true || observedPtyIds?.has(ptyId) === true)
      )
    }
  }
}

/**
 * Adjudicates a close whose addressed surface is already absent.
 * Lifecycle echoes are idempotent: a provider exit may have already retired the
 * surface before the viewer reports its stale close. A user close still fails
 * closed so an unknown target cannot be hidden.
 */
export function adjudicateAbsentMobileSessionTabClose(args: {
  host: MobileSessionLifecycleCloseHost
  context: MobileSessionLifecycleCloseContext
  worktreeId: string
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined
  reason: RuntimeSessionTabCloseReason | undefined
  addressedByPtyCloseAuthority: boolean
}): MobileSessionTabCloseOutcome {
  const { host, context, worktreeId, snapshot, reason } = args
  if (reason === undefined || reason === 'user') {
    throw new Error(args.addressedByPtyCloseAuthority ? 'terminal_handle_stale' : 'tab_not_found')
  }
  // A missing leaf can still be part of a live split parent. Closing that
  // parent would take the surviving sibling down, so retain the refusal
  // even though the addressed leaf has already been retired.
  const hasLiveRendererParentLeaf = context.rendererLeaves.some(context.rendererLeafHasConnectedPty)
  if (context.parentLeaves.some(context.leafHasConnectedPty) || hasLiveRendererParentLeaf) {
    const addressedDeadRendererLeaf =
      context.closeLeafId !== null &&
      !context.rendererLeaves.some(
        (leaf) => leaf.leafId === context.closeLeafId && context.rendererLeafHasConnectedPty(leaf)
      )
    if (addressedDeadRendererLeaf) {
      return refusedMobileSessionTabClose('live-host-pty')
    }
    if (snapshot) {
      host.republishSnapshot(worktreeId)
    }
    return refusedMobileSessionTabClose('live-host-pty')
  }
  // The renderer owns a graph-visible parent, including a dead leaf whose
  // lifecycle echo arrived after main retired its mirror. Leave retirement
  // to that renderer instead of acknowledging a host-side close.
  if (context.closeParentTabId && host.tabs.has(context.closeParentTabId)) {
    return refusedMobileSessionTabClose('retirement-owner')
  }
  return delegatedMobileSessionTabClose()
}
