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
