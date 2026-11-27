import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncedLeaf
} from '../../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'

export function parseTabIdFromPaneKey(paneKey: string | null | undefined): string | null {
  if (!paneKey) {
    return null
  }
  const parsed = parsePaneKey(paneKey)?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId
  if (parsed) {
    return parsed
  }
  const colonIndex = paneKey.indexOf(':')
  return colonIndex > 0 ? paneKey.slice(0, colonIndex) : null
}

export function lookupPersistedSessionCustomTitle(
  session: WorkspaceSessionState,
  sessionId: string,
  readLiveTerminalCustomTitle: (args: { tabId?: string; terminalHandle?: string }) => string | null
): string | null {
  for (const tabs of Object.values(session.tabsByWorktree)) {
    const match = tabs.find(
      (tab) => tab.aiVaultTitle?.sessionId === sessionId && tab.customTitle?.trim()
    )
    if (match?.customTitle?.trim()) {
      return match.customTitle.trim()
    }
  }
  if (session.unifiedTabs) {
    for (const tabs of Object.values(session.unifiedTabs)) {
      const match = tabs.find(
        (tab) =>
          (tab.aiVaultTitle?.sessionId === sessionId ||
            (tab.contentType === 'agent-session' && tab.entityId === sessionId)) &&
          tab.customLabel?.trim()
      )
      if (match?.customLabel?.trim()) {
        return match.customLabel.trim()
      }
    }
  }
  if (session.sleepingAgentSessionsByPaneKey) {
    for (const [paneKey, record] of Object.entries(session.sleepingAgentSessionsByPaneKey)) {
      if (record.providerSession?.id !== sessionId) {
        continue
      }
      const sleepingTitle = readLiveTerminalCustomTitle({
        tabId: record.tabId ?? parseTabIdFromPaneKey(paneKey) ?? undefined
      })
      if (sleepingTitle) {
        return sleepingTitle
      }
    }
  }
  return null
}

export function lookupPersistedTabCustomTitle(
  session: WorkspaceSessionState,
  tabId: string,
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
): string | null {
  const layout = session.terminalLayoutsByTabId?.[tabId]
  if (layout?.ptyIdsByLeafId) {
    for (const ptyId of Object.values(layout.ptyIdsByLeafId)) {
      if (ptyId) {
        const title = ptysById.get(ptyId)?.customTitle?.trim()
        if (title) {
          return title
        }
      }
    }
  }
  for (const tabs of Object.values(session.tabsByWorktree)) {
    const match = tabs.find((tab) => tab.id === tabId)
    if (match?.customTitle?.trim()) {
      return match.customTitle.trim()
    }
    if (match?.ptyId) {
      const ptyTitle = ptysById.get(match.ptyId)?.customTitle?.trim()
      if (ptyTitle) {
        return ptyTitle
      }
    }
  }
  if (session.unifiedTabs) {
    for (const tabs of Object.values(session.unifiedTabs)) {
      const match = tabs.find(
        (tab) => (tab.id === tabId || tab.entityId === tabId) && tab.customLabel?.trim()
      )
      if (match?.customLabel?.trim()) {
        return match.customLabel.trim()
      }
    }
  }
  return null
}

export function resolvePersistedSessionIdForTab(
  session: WorkspaceSessionState,
  tabId: string
): string | null {
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
      if (unified?.contentType === 'agent-session' && unified.entityId) {
        return unified.entityId
      }
    }
  }
  if (session.sleepingAgentSessionsByPaneKey) {
    for (const [paneKey, record] of Object.entries(session.sleepingAgentSessionsByPaneKey)) {
      if (
        (record.tabId === tabId || parseTabIdFromPaneKey(paneKey) === tabId) &&
        record.providerSession?.id
      ) {
        return record.providerSession.id
      }
    }
  }
  return null
}

export function resolveRealTabIdFromRuntimeState(args: {
  ptyId: string
  worktreeId?: string
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  leaves: ReadonlyMap<string, RuntimeSyncedLeaf>
  mobileSessionTabsByWorktree: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
  session: WorkspaceSessionState | null | undefined
}): string | null {
  const { ptyId, worktreeId, ptysById, leaves, mobileSessionTabsByWorktree, session } = args
  const pty = ptysById.get(ptyId)
  if (pty?.tabId && !pty.tabId.startsWith('pty:')) {
    return pty.tabId
  }
  const paneTabId = parseTabIdFromPaneKey(pty?.paneKey)
  if (paneTabId && !paneTabId.startsWith('pty:')) {
    return paneTabId
  }
  for (const leaf of leaves.values()) {
    if (leaf.ptyId === ptyId && leaf.tabId && !leaf.tabId.startsWith('pty:')) {
      return leaf.tabId
    }
  }
  for (const snapshot of mobileSessionTabsByWorktree.values()) {
    if (worktreeId && snapshot.worktree !== worktreeId) {
      continue
    }
    for (const tab of snapshot.tabs) {
      if (
        tab.type === 'terminal' &&
        tab.ptyId === ptyId &&
        tab.parentTabId &&
        !tab.parentTabId.startsWith('pty:')
      ) {
        return tab.parentTabId
      }
    }
  }
  if (session) {
    const worktreeEntries = worktreeId
      ? ([[worktreeId, session.tabsByWorktree[worktreeId] ?? []]] as const)
      : Object.entries(session.tabsByWorktree)
    for (const [, tabs] of worktreeEntries) {
      const match = tabs.find((tab) => tab.ptyId === ptyId)
      if (match?.id) {
        return match.id
      }
    }
    if (session.terminalLayoutsByTabId) {
      for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId)) {
        if (layout?.ptyIdsByLeafId && Object.values(layout.ptyIdsByLeafId).includes(ptyId)) {
          return tabId
        }
      }
    }
  }
  return null
}
