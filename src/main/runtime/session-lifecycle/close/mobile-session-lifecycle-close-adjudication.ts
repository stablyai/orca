import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSessionTabCloseReason,
  RuntimeSyncedTab
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { MobileSessionTabCloseOutcome } from './mobile-session-tab-close-outcome'
import {
  delegatedMobileSessionTabClose,
  refusedMobileSessionTabClose
} from './mobile-session-tab-close-outcome'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../terminal/records/runtime-terminal-state-records'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'

export type MobileSessionLifecycleCloseHost = {
  tabs: ReadonlyMap<string, RuntimeSyncedTab>
  leaves: ReadonlyMap<string, RuntimeLeafRecord>
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  findPtyForMobileTerminalTab: (
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ) => RuntimePtyWorktreeRecord | null
  republishSnapshot: (worktreeId: string) => void
  terminalHandleOf: (worktreeId: string, tab: RuntimeMobileSessionTerminalTab) => string | null
}

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
    // Disconnected PTY records outlive exit; only connected/daemon evidence proves liveness.
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

/** Absent lifecycle echoes are idempotent; absent user-close targets fail closed. */
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
  // A retired leaf can still have live siblings; never close their parent.
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
  // Renderer-visible parents remain renderer-owned even after main retires the mirrored dead leaf.
  if (context.closeParentTabId && host.tabs.has(context.closeParentTabId)) {
    return refusedMobileSessionTabClose('retirement-owner')
  }
  return delegatedMobileSessionTabClose()
}

/** Refuses a close whose terminal incarnation, or the set of live terminals the user approved, no longer matches the host. */
export function refuseStaleTerminalClose(args: {
  host: MobileSessionLifecycleCloseHost
  worktreeId: string
  tab: RuntimeMobileSessionSnapshotTab
  tabId: string
  snapshot: RuntimeMobileSessionTabsSnapshot
  expectedHandle: string | undefined
  /** A live terminal outside this set, or with no handle, was never shown to the user. */
  approvedHandles: readonly string[] | undefined
}): MobileSessionTabCloseOutcome | null {
  const { host, worktreeId, tab, tabId, snapshot, expectedHandle, approvedHandles } = args
  const siblings = (row: RuntimeMobileSessionSnapshotTab): boolean =>
    tab.type === 'terminal' && row.type === 'terminal' && row.parentTabId === tab.parentTabId
  const stale =
    (expectedHandle !== undefined &&
      !snapshot.tabs.some(
        (row) =>
          row.type === 'terminal' &&
          siblings(row) &&
          host.terminalHandleOf(worktreeId, row) === expectedHandle
      )) ||
    (approvedHandles !== undefined &&
      // A pane address stops only that pane; a parent address stops every pane of the tab.
      (tab.id === tabId ? [tab] : snapshot.tabs).some((row) => {
        if (
          row.type !== 'terminal' ||
          !siblings(row) ||
          !host.findPtyForMobileTerminalTab(worktreeId, row)
        ) {
          return false
        }
        const handle = host.terminalHandleOf(worktreeId, row)
        return handle === null || !approvedHandles.includes(handle)
      }))
  if (!stale) {
    return null
  }
  host.republishSnapshot(worktreeId)
  return refusedMobileSessionTabClose('stale-terminal', { snapshotRepublished: true })
}
