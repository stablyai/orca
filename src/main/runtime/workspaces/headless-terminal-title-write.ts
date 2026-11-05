import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeTerminalRename
} from '../../../shared/runtime-types'
import type { RuntimeSyncedTab } from '../../../shared/runtime-session-contracts'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { TerminalHandleRecord } from '../runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import { getLatestLeafTitle, getLeafDisplayRecord } from '../runtime-worktree-status-projection'

export type HeadlessTitleWriteHost = {
  leaves: { values(): Iterable<RuntimeLeafRecord> }
  ptysById: { get(ptyId: string): RuntimePtyWorktreeRecord | undefined }
  tabs: { get(tabId: string): RuntimeSyncedTab | undefined }
  mobileSessionTabsByWorktree: {
    get(worktreeId: string): RuntimeMobileSessionTabsSnapshot | undefined
  }
  storeMobileSessionSnapshot(worktreeId: string, snapshot: RuntimeMobileSessionTabsSnapshot): void
  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null | undefined
  store?: { setWorkspaceSession?: unknown } | null
  setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void
  resolveSessionIdForTab(tabId: string, handle?: string): string | null
  setSessionCustomTitle(sessionId: string, title: string | null): void
}

export type HeadlessTerminalRenameHost = HeadlessTitleWriteHost & {
  getLivePtyForHandle(handle: string): {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null
  paneOfPty(pty: RuntimePtyWorktreeRecord): { tabId: string | null }
  touchMobileSessionSnapshotsForPty(ptyId: string): void
  resolveRealTabIdForPty(ptyId: string, worktreeId?: string, handle?: string): string | null
  rememberManualTerminalTitle(tabId: string | null, title: string | null): void
  notifier: {
    renameTerminal(tabId: string, title: string | null): void
  } | null
  persistHeadlessTerminalTitle(worktreeId: string, tabId: string, title: string | null): void
  applyHeadlessSessionTabPropsToSnapshot(
    worktreeId: string,
    tabId: string,
    props: { customTitle: string | null; title?: string }
  ): void
  headlessTerminalFallbackTitle(worktreeId: string, tabId: string): string
  rememberTerminalSessionTitle(
    tabId: string | null | undefined,
    handle: string | undefined,
    title: string | null
  ): void
  assertGraphReady(): void
  getLiveLeafForHandle(handle: string): { leaf: RuntimeLeafRecord }
  touchMobileSessionTabsForWorktree(worktreeId: string, options: { immediate: true }): void
}

function updateHeadlessWorkspaceContent(
  host: HeadlessTitleWriteHost,
  worktreeId: string,
  update: (session: WorkspaceSessionState) => WorkspaceSessionState | null
): void {
  const session = host.getWorkspaceSessionForWorktree(worktreeId)
  if (!session || !host.store?.setWorkspaceSession) {
    return
  }
  const next = update(session)
  if (next) {
    host.setWorkspaceSessionForWorktree(worktreeId, next)
  }
}

/** Persist a manual rename so a headless rebuild does not restore the generated title. */
export function writeHeadlessTerminalTitle(
  host: HeadlessTitleWriteHost,
  worktreeId: string,
  tabId: string,
  title: string | null
): void {
  const normalizedTitle = title?.trim() || null
  let fallbackTitle: string | null = null
  if (normalizedTitle === null) {
    for (const leaf of host.leaves.values()) {
      if (leaf.tabId === tabId) {
        const pty = leaf.ptyId ? host.ptysById.get(leaf.ptyId) : undefined
        fallbackTitle =
          getLatestLeafTitle(getLeafDisplayRecord(leaf, null), null) ?? pty?.title ?? null
        break
      }
    }
  }
  const inMemoryTab = host.tabs.get(tabId)
  if (inMemoryTab) {
    inMemoryTab.customTitle = normalizedTitle
    inMemoryTab.title = normalizedTitle ?? fallbackTitle ?? 'Terminal'
  }
  const snapshot = host.mobileSessionTabsByWorktree.get(worktreeId)
  if (snapshot) {
    const tabs = snapshot.tabs.map((tab) => {
      if (tab.type === 'terminal' && tab.parentTabId === tabId) {
        return {
          ...tab,
          customTitle: normalizedTitle,
          title: normalizedTitle ?? fallbackTitle ?? 'Terminal'
        }
      }
      if (tab.type === 'agent-session' && tab.id === tabId) {
        return {
          ...tab,
          customTitle: normalizedTitle,
          ...(normalizedTitle ? { title: normalizedTitle } : {})
        }
      }
      return tab
    })
    host.storeMobileSessionSnapshot(worktreeId, {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1,
      tabs
    })
  }
  updateHeadlessWorkspaceContent(host, worktreeId, (session) => {
    const tabs = session.tabsByWorktree[worktreeId]
    if (!tabs?.some((tab) => tab.id === tabId)) {
      return null
    }
    return {
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [worktreeId]: tabs.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                customTitle: normalizedTitle,
                ...(normalizedTitle === null && fallbackTitle !== null
                  ? { title: fallbackTitle }
                  : {})
              }
            : tab
        )
      }
    }
  })
  const sessionId = host.resolveSessionIdForTab(tabId)
  if (sessionId) {
    host.setSessionCustomTitle(sessionId, normalizedTitle)
  }
}

/** Rename a terminal the desktop layout does not own, including its session alias. */
export function renameHeadlessTerminal(
  host: HeadlessTerminalRenameHost,
  handle: string,
  title: string | null
): RuntimeTerminalRename {
  const normalizedTitle = title?.trim() || null
  const pty = host.getLivePtyForHandle(handle)
  if (pty) {
    // Keep manual names out of process-title evidence or they read as the shell reclaiming the pane (#20626).
    pty.pty.customTitle = normalizedTitle
    pty.pty.manualTitle = normalizedTitle
    const recordedTabId = (): string | null => host.paneOfPty(pty.pty).tabId
    host.touchMobileSessionSnapshotsForPty(pty.pty.ptyId)
    const layoutTabId =
      recordedTabId() ??
      pty.pty.tabId ??
      host.resolveRealTabIdForPty(pty.pty.ptyId, pty.pty.worktreeId, handle)
    if (!ORCA_LAYOUT_OWNER_IS_MAIN && layoutTabId && !pty.pty.tabId) {
      pty.pty.tabId = layoutTabId
    }
    const tabId = layoutTabId ?? pty.record.tabId
    host.rememberManualTerminalTitle(tabId, normalizedTitle)
    // Persist headless custom titles so restart cannot lose a rename.
    if (!host.notifier?.renameTerminal && layoutTabId) {
      host.persistHeadlessTerminalTitle(pty.pty.worktreeId, layoutTabId, normalizedTitle)
      // Publish manual titles: paired desktops prefer saved-session names over live titles (#29975).
      host.applyHeadlessSessionTabPropsToSnapshot(pty.pty.worktreeId, layoutTabId, {
        customTitle: normalizedTitle,
        // Reset must also drop a name saved while sleeping.
        ...(normalizedTitle === null
          ? { title: host.headlessTerminalFallbackTitle(pty.pty.worktreeId, layoutTabId) }
          : {})
      })
    }
    // A window notifier only renames the open tab. The session alias still has to be stored.
    for (const leaf of host.leaves.values()) {
      if (leaf.ptyId === pty.pty.ptyId) {
        host.rememberManualTerminalTitle(leaf.tabId, normalizedTitle)
        if (host.notifier?.renameTerminal) {
          host.persistHeadlessTerminalTitle(pty.pty.worktreeId, leaf.tabId, normalizedTitle)
        }
        host.rememberTerminalSessionTitle(leaf.tabId, handle, normalizedTitle)
        host.notifier?.renameTerminal(leaf.tabId, normalizedTitle)
        return { handle, tabId: leaf.tabId, title: normalizedTitle }
      }
    }
    // A notifier can exist before its pane graph; retain the rename on the known tab.
    if (host.notifier?.renameTerminal && tabId) {
      host.persistHeadlessTerminalTitle(pty.pty.worktreeId, tabId, normalizedTitle)
      host.rememberTerminalSessionTitle(tabId, handle, normalizedTitle)
      host.notifier.renameTerminal(tabId, normalizedTitle)
    } else {
      host.rememberTerminalSessionTitle(tabId, handle, normalizedTitle)
    }
    return { handle, tabId, title: normalizedTitle }
  }
  host.assertGraphReady()
  const { leaf } = host.getLiveLeafForHandle(handle)
  const boundPty = leaf.ptyId ? host.ptysById.get(leaf.ptyId) : null
  if (boundPty) {
    boundPty.customTitle = normalizedTitle
    boundPty.manualTitle = normalizedTitle
    host.touchMobileSessionSnapshotsForPty(boundPty.ptyId)
  }
  host.rememberManualTerminalTitle(leaf.tabId, normalizedTitle)
  host.persistHeadlessTerminalTitle(leaf.worktreeId, leaf.tabId, normalizedTitle)
  host.rememberTerminalSessionTitle(leaf.tabId, handle, normalizedTitle)
  host.notifier?.renameTerminal(leaf.tabId, normalizedTitle)
  host.touchMobileSessionTabsForWorktree(leaf.worktreeId, { immediate: true })
  return { handle, tabId: leaf.tabId, title: normalizedTitle }
}
