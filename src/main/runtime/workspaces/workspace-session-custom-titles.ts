import { RuntimeHeadlessTabGroups } from '../session-tabs/headless-tab-group-moves'
import {
  lookupPersistedSessionCustomTitle,
  lookupPersistedTabCustomTitle,
  parseTabIdFromPaneKey,
  resolvePersistedSessionIdForTab,
  resolveRealTabIdFromRuntimeState
} from './workspace-session-custom-title-resolution'

export abstract class RuntimeWorkspaceSessionCustomTitles extends RuntimeHeadlessTabGroups {
  protected readonly inMemorySessionCustomTitles = new Map<string, string>()

  getSessionCustomTitle(sessionId: string): string | null {
    if (!sessionId) {
      return null
    }
    const session = this.store?.getWorkspaceSession?.()
    const titles = session?.sessionCustomTitles
    const lookup = (id: string): string | null =>
      this.inMemorySessionCustomTitles.get(id) ??
      titles?.[id] ??
      this.lookupLiveSessionCustomTitle(id)

    const direct = lookup(sessionId)
    if (direct) {
      return direct
    }
    if (sessionId.includes(':')) {
      const bare = sessionId.split(':').at(-1)
      if (bare) {
        return lookup(bare)
      }
    }
    return null
  }

  private lookupLiveSessionCustomTitle(sessionId: string): string | null {
    for (const pty of this.ptysById.values()) {
      if (pty.providerSessionId === sessionId && pty.customTitle?.trim()) {
        return pty.customTitle.trim()
      }
    }
    for (const tab of this.tabs.values()) {
      if (tab.aiVaultTitle?.sessionId === sessionId && tab.customTitle?.trim()) {
        return tab.customTitle.trim()
      }
    }
    const statusRows =
      this.getAgentProviderSessionSnapshotFn?.() ?? this.getAgentStatusSnapshotFn?.() ?? []
    for (const entry of statusRows) {
      if (entry.providerSession?.id !== sessionId) {
        continue
      }
      const liveTitle = this.readLiveTerminalCustomTitle({
        tabId: entry.tabId ?? parseTabIdFromPaneKey(entry.paneKey) ?? undefined,
        ...(entry.terminalHandle ? { terminalHandle: entry.terminalHandle } : {})
      })
      if (liveTitle) {
        return liveTitle
      }
    }
    const session = this.store?.getWorkspaceSession?.()
    return session
      ? lookupPersistedSessionCustomTitle(session, sessionId, (args) =>
          this.readLiveTerminalCustomTitle(args)
        )
      : null
  }

  setSessionCustomTitle(sessionId: string, title: string | null): void {
    if (!sessionId) {
      return
    }
    const normalized = title?.trim().slice(0, 256) || null
    if (normalized) {
      this.inMemorySessionCustomTitles.set(sessionId, normalized)
    } else {
      this.inMemorySessionCustomTitles.delete(sessionId)
    }
    const session = this.store?.getWorkspaceSession?.()
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const current = session.sessionCustomTitles?.[sessionId] ?? null
    if (current === normalized) {
      return
    }
    const nextTitles = { ...session.sessionCustomTitles }
    if (normalized) {
      nextTitles[sessionId] = normalized
    } else {
      delete nextTitles[sessionId]
    }
    this.store.setWorkspaceSession({
      ...session,
      sessionCustomTitles: nextTitles
    })
  }

  readLiveTerminalCustomTitle(args: { tabId?: string; terminalHandle?: string }): string | null {
    if (args.terminalHandle) {
      const live = this.getLivePtyForHandle(args.terminalHandle)?.pty.customTitle?.trim()
      if (live) {
        return live
      }
      const record = this.handles.get(args.terminalHandle)
      const recorded = record?.ptyId ? this.ptysById.get(record.ptyId)?.customTitle?.trim() : null
      if (recorded) {
        return recorded
      }
      const handleTab = record?.tabId ? this.tabs.get(record.tabId)?.customTitle?.trim() : null
      if (handleTab) {
        return handleTab
      }
    }
    if (!args.tabId) {
      return null
    }
    const tabTitle = this.tabs.get(args.tabId)?.customTitle?.trim()
    if (tabTitle) {
      return tabTitle
    }
    for (const pty of this.ptysById.values()) {
      if (
        (pty.tabId === args.tabId || parseTabIdFromPaneKey(pty.paneKey) === args.tabId) &&
        pty.customTitle?.trim()
      ) {
        return pty.customTitle.trim()
      }
    }
    for (const leaf of this.leaves.values()) {
      if (leaf.tabId === args.tabId && leaf.ptyId) {
        const title = this.ptysById.get(leaf.ptyId)?.customTitle?.trim()
        if (title) {
          return title
        }
      }
    }
    const session = this.store?.getWorkspaceSession?.()
    return session ? lookupPersistedTabCustomTitle(session, args.tabId, this.ptysById) : null
  }

  protected rememberTerminalSessionTitle(
    tabId: string | null | undefined,
    handle: string | undefined,
    title: string | null
  ): void {
    if (!tabId && !handle) {
      return
    }
    const sessionId = this.resolveSessionIdForTab(tabId ?? '', handle)
    if (sessionId) {
      this.setSessionCustomTitle(sessionId, title)
    }
  }

  resolveRealTabIdForPty(ptyId: string, worktreeId?: string, _handle?: string): string | null {
    return resolveRealTabIdFromRuntimeState({
      ptyId,
      worktreeId,
      ptysById: this.ptysById,
      leaves: this.leaves,
      mobileSessionTabsByWorktree: this.mobileSessionTabsByWorktree,
      session: this.store?.getWorkspaceSession?.()
    })
  }

  resolveSessionIdForTab(tabId: string, handle?: string): string | null {
    if (!tabId || tabId.startsWith('pty:')) {
      const ptyId = tabId.startsWith('pty:')
        ? tabId.slice(4)
        : handle
          ? (this.getLivePtyForHandle(handle)?.pty.ptyId ?? this.handles.get(handle)?.ptyId)
          : undefined
      if (ptyId) {
        tabId = this.resolveRealTabIdForPty(ptyId, undefined, handle) ?? tabId
      }
    }
    const inMemoryTab = tabId ? this.tabs.get(tabId) : undefined
    if (inMemoryTab?.aiVaultTitle?.sessionId) {
      return inMemoryTab.aiVaultTitle.sessionId
    }
    const session = this.store?.getWorkspaceSession?.()
    if (session && tabId) {
      const persistedId = resolvePersistedSessionIdForTab(session, tabId)
      if (persistedId) {
        return persistedId
      }
    }
    const paneKeys: string[] = []
    if (tabId) {
      for (const leaf of this.leaves.values()) {
        if (leaf.tabId === tabId) {
          paneKeys.push(this.makeRuntimePaneKey(leaf))
        }
      }
    }
    const statusRows =
      this.getAgentProviderSessionSnapshotFn?.() ?? this.getAgentStatusSnapshotFn?.() ?? []
    for (const entry of statusRows) {
      const parsedTabId = parseTabIdFromPaneKey(entry.paneKey)
      const matches =
        (Boolean(handle) && entry.terminalHandle === handle) ||
        (Boolean(tabId) &&
          (entry.tabId === tabId || parsedTabId === tabId || paneKeys.includes(entry.paneKey)))
      if (matches && entry.providerSession?.id) {
        return entry.providerSession.id
      }
    }
    if (tabId) {
      for (const leaf of this.leaves.values()) {
        if (leaf.tabId === tabId && leaf.ptyId) {
          const recorded = this.ptysById.get(leaf.ptyId)?.providerSessionId
          if (recorded) {
            return recorded
          }
        }
      }
      for (const pty of this.ptysById.values()) {
        if (
          (pty.tabId === tabId || parseTabIdFromPaneKey(pty.paneKey) === tabId) &&
          pty.providerSessionId
        ) {
          return pty.providerSessionId
        }
      }
    }
    if (handle) {
      const recorded = this.getLivePtyForHandle(handle)?.pty.providerSessionId
      if (recorded) {
        return recorded
      }
    }
    if (tabId) {
      for (const leaf of this.leaves.values()) {
        if (leaf.tabId === tabId) {
          const paneKey = this.makeRuntimePaneKey(leaf)
          const entries =
            this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ??
            this.getAgentStatusSnapshotForPaneFn?.(paneKey) ??
            statusRows.filter((row) => row.paneKey === paneKey)
          for (const entry of entries) {
            if (entry.providerSession?.id) {
              return entry.providerSession.id
            }
          }
        }
      }
    }
    const handlePtyId = handle
      ? (this.getLivePtyForHandle(handle)?.pty.ptyId ?? this.handles.get(handle)?.ptyId)
      : undefined
    for (const snapshot of this.mobileSessionTabsByWorktree.values()) {
      for (const tab of snapshot.tabs) {
        const matchesTab =
          (Boolean(tabId) &&
            (tab.id === tabId || (tab.type === 'terminal' && tab.parentTabId === tabId))) ||
          (Boolean(handlePtyId) && tab.type === 'terminal' && tab.ptyId === handlePtyId)
        if (matchesTab) {
          if (tab.type === 'agent-session' && tab.sessionId) {
            return tab.sessionId
          }
          if ('agentStatus' in tab && tab.agentStatus?.providerSession?.id) {
            return tab.agentStatus.providerSession.id
          }
        }
      }
    }
    return tabId.startsWith('agent-session:') ? tabId.slice('agent-session:'.length) : null
  }
}
