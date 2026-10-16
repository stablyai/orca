import { RuntimeHeadlessTabGroups } from '../session-tabs/headless-tab-group-moves'

export abstract class RuntimeWorkspaceSessionCustomTitles extends RuntimeHeadlessTabGroups {
  protected readonly inMemorySessionCustomTitles = new Map<string, string>()

  getSessionCustomTitle(sessionId: string): string | null {
    if (!sessionId) {
      return null
    }
    return (
      this.inMemorySessionCustomTitles.get(sessionId) ??
      this.store?.getWorkspaceSession?.()?.sessionCustomTitles?.[sessionId] ??
      null
    )
  }

  setSessionCustomTitle(sessionId: string, title: string | null): void {
    if (!sessionId) {
      return
    }
    const normalized = title?.trim() || null
    if (normalized) {
      this.inMemorySessionCustomTitles.set(sessionId, normalized)
    } else {
      this.inMemorySessionCustomTitles.delete(sessionId)
    }
    const session = this.store?.getWorkspaceSession?.()
    if (!session || !this.store?.setWorkspaceSession) {
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

  resolveSessionIdForTab(tabId: string): string | null {
    const session = this.store?.getWorkspaceSession?.()
    if (session) {
      for (const tabs of Object.values(session.tabsByWorktree)) {
        const persisted = tabs.find((tab) => tab.id === tabId)
        if (persisted?.aiVaultTitle?.sessionId) {
          return persisted.aiVaultTitle.sessionId
        }
      }
      if (session.unifiedTabs) {
        for (const tabs of Object.values(session.unifiedTabs)) {
          const unified = tabs.find((tab) => tab.entityId === tabId || tab.id === tabId)
          if (unified?.aiVaultTitle?.sessionId) {
            return unified.aiVaultTitle.sessionId
          }
        }
      }
    }
    for (const leaf of this.leaves.values()) {
      if (leaf.tabId === tabId) {
        const paneKey = this.makeRuntimePaneKey(leaf)
        const entries =
          this.getAgentStatusSnapshotForPaneFn?.(paneKey) ??
          this.getAgentStatusSnapshotFn?.().filter((row) => row.paneKey === paneKey) ??
          []
        for (const entry of entries) {
          if (entry.providerSession?.id) {
            return entry.providerSession.id
          }
        }
      }
    }
    for (const snapshot of this.mobileSessionTabsByWorktree.values()) {
      for (const tab of snapshot.tabs) {
        if (tab.id === tabId || (tab.type === 'terminal' && tab.parentTabId === tabId)) {
          if (tab.type === 'agent-session' && tab.sessionId) {
            return tab.sessionId
          }
          if ('agentStatus' in tab && tab.agentStatus?.providerSession?.id) {
            return tab.agentStatus.providerSession.id
          }
        }
      }
    }
    if (tabId.startsWith('agent-session:')) {
      return tabId.slice('agent-session:'.length)
    }
    return null
  }
}
