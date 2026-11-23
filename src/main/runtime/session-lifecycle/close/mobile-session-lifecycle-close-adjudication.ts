import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSessionTabCloseReason,
  RuntimeSyncedTab
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type {
  MobileSessionTabCloseOptions,
  MobileSessionTabCloseOutcome
} from './mobile-session-tab-close-outcome'
import {
  delegatedMobileSessionTabClose,
  refusedMobileSessionTabClose
} from './mobile-session-tab-close-outcome'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../terminal/records/runtime-terminal-state-records'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import { parseAppSshPtyId } from '../../../../shared/remote-runtime/ssh/ssh-pty-id'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { isTerminalTabPinnedInSession } from '../../session-tabs/terminal-retirement/paired-host-terminal-close'

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
  mainSurfaces?: {
    ownsWorkspace: (worktreeId: string) => boolean
    panesOfTab: (tabId: string) => readonly { leafId: string; ptyId: string | null }[]
  } | null
  workspaceSessionOf?: (worktreeId: string) => WorkspaceSessionState | null | undefined
  handleOfPtyId?: (ptyId: string) => string | null
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
  observedPtyIds: ReadonlySet<string> | null
  options: Pick<
    MobileSessionTabCloseOptions,
    'expectedTerminalHandle' | 'approvedTerminalHandles' | 'force'
  >
}): MobileSessionTabCloseOutcome | null {
  const { host, worktreeId, tab, tabId, snapshot, observedPtyIds, options } = args
  const {
    expectedTerminalHandle: expectedHandle,
    approvedTerminalHandles: approvedHandles,
    force
  } = options
  const siblings = (row: RuntimeMobileSessionSnapshotTab): boolean =>
    tab.type === 'terminal' && row.type === 'terminal' && row.parentTabId === tab.parentTabId
  const isLivePty = (ptyId: string, record: RuntimePtyWorktreeRecord | null | undefined): boolean =>
    record?.connected === true ||
    observedPtyIds?.has(ptyId) === true ||
    (Boolean(parseAppSshPtyId(ptyId)) && record?.connected !== false)
  const closingWholeParent = tab.type === 'terminal' && tab.id !== tabId
  const hasUnapprovedSnapshotTerminal = (): boolean =>
    (closingWholeParent ? snapshot.tabs : [tab]).some((row) => {
      if (row.type !== 'terminal' || !siblings(row)) {
        return false
      }
      const pty = host.findPtyForMobileTerminalTab(worktreeId, row)
      if (!pty || !isLivePty(pty.ptyId, pty)) {
        return false
      }
      const handle = host.terminalHandleOf(worktreeId, row)
      return handle === null || !approvedHandles!.includes(handle)
    })
  // Main-owned and headless layouts can bind a replacement or new split before snapshot.tabs republishes.
  const hasUnapprovedSessionPaneTerminal = (): boolean => {
    if (tab.type !== 'terminal' || (!host.mainSurfaces && !host.workspaceSessionOf)) {
      return false
    }
    const mainPanes = host.mainSurfaces?.ownsWorkspace(worktreeId)
      ? host.mainSurfaces.panesOfTab(tab.parentTabId)
      : []
    const panes = collectSessionPanesForTab(
      worktreeId,
      tab.parentTabId,
      mainPanes,
      host.workspaceSessionOf?.(worktreeId)
    ).filter((pane) => closingWholeParent || pane.leafId === tab.leafId)
    return panes.some((pane) => {
      if (!pane.ptyId) {
        return false
      }
      const record = host.ptysById.get(pane.ptyId)
      if (!isLivePty(pane.ptyId, record)) {
        return false
      }
      const handle = host.handleOfPtyId?.(pane.ptyId) ?? null
      return handle === null || !approvedHandles!.includes(handle)
    })
  }
  const stale =
    (expectedHandle !== undefined &&
      !snapshot.tabs.some(
        (row) =>
          row.type === 'terminal' &&
          siblings(row) &&
          host.terminalHandleOf(worktreeId, row) === expectedHandle
      )) ||
    (approvedHandles !== undefined &&
      (hasUnapprovedSnapshotTerminal() || hasUnapprovedSessionPaneTerminal()))
  if (!stale) {
    if (
      closingWholeParent &&
      !force &&
      isTerminalTabPinnedOnHost(
        worktreeId,
        tab.parentTabId,
        snapshot.tabs,
        host.workspaceSessionOf?.(worktreeId)
      )
    ) {
      host.republishSnapshot(worktreeId)
      throw new Error('terminal_tab_pinned')
    }
    return null
  }
  host.republishSnapshot(worktreeId)
  return refusedMobileSessionTabClose('stale-terminal', { snapshotRepublished: true })
}

export function collectSessionPanesForTab(
  worktreeId: string,
  parentTabId: string,
  mainPanes: readonly { leafId: string; ptyId: string | null }[],
  session: WorkspaceSessionState | null | undefined
): { leafId: string | null; ptyId: string | null }[] {
  const panes: { leafId: string | null; ptyId: string | null }[] = [...mainPanes]
  const layout = session?.terminalLayoutsByTabId?.[parentTabId]
  if (layout?.ptyIdsByLeafId) {
    for (const [leafId, ptyId] of Object.entries(layout.ptyIdsByLeafId)) {
      panes.push({ leafId, ptyId: ptyId ?? null })
    }
  }
  const persistedTab = session?.tabsByWorktree?.[worktreeId]?.find(
    (entry) => entry.id === parentTabId
  )
  if (persistedTab?.ptyId) {
    panes.push({ leafId: null, ptyId: persistedTab.ptyId })
  }
  return panes
}

export function isTerminalTabPinnedOnHost(
  worktreeId: string,
  parentTabId: string,
  tabs: readonly RuntimeMobileSessionSnapshotTab[],
  session: WorkspaceSessionState | null | undefined
): boolean {
  return (
    tabs.some(
      (candidate) =>
        candidate.type === 'terminal' &&
        candidate.parentTabId === parentTabId &&
        candidate.isPinned === true
    ) || isTerminalTabPinnedInSession(session, { worktreeId, tabId: parentTabId })
  )
}
