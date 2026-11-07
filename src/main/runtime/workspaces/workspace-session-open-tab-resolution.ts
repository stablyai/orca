import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import type { AiVaultSessionOpenTab } from '../../../shared/ai-vault-types'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncedLeaf
} from '../../../shared/runtime-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'

type OpenTabResolutionTab = {
  id?: string
  worktreeId?: string
  aiVaultTitle?: { sessionId: string } | null
}

type OpenTabResolutionPty = Pick<RuntimePtyWorktreeRecord, 'providerSessionId'> & {
  tabId?: string | null
  paneKey?: string | null
}

type OpenTabResolutionArgs = {
  sessionId: string
  mobileSessionTabsByWorktree: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
  leaves: ReadonlyMap<string, RuntimeSyncedLeaf>
  tabs: ReadonlyMap<string, OpenTabResolutionTab>
  ptysById: ReadonlyMap<string, OpenTabResolutionPty>
  statusRows: readonly AgentStatusIpcPayload[]
  session: WorkspaceSessionState | null | undefined
  resolveSessionIdForTab?: (tabId: string, handle?: string) => string | null
}

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

function resolveSessionIdForTabFromState(args: OpenTabResolutionArgs, tabId: string): string | null {
  if (!tabId) {
    return null
  }
  const customResolved = args.resolveSessionIdForTab?.(tabId)
  if (customResolved) {
    return customResolved
  }
  if (args.session) {
    const persistedId = resolvePersistedSessionIdForTab(args.session, tabId)
    if (persistedId) {
      return persistedId
    }
  }
  for (const row of args.statusRows) {
    if (
      (row.tabId === tabId || parseTabIdFromPaneKey(row.paneKey) === tabId) &&
      row.providerSession?.id
    ) {
      return row.providerSession.id
    }
  }
  for (const pty of args.ptysById.values()) {
    if (
      (pty.tabId === tabId || parseTabIdFromPaneKey(pty.paneKey) === tabId) &&
      pty.providerSessionId
    ) {
      return pty.providerSessionId
    }
  }
  return tabId.startsWith('agent-session:') ? tabId.slice('agent-session:'.length) : null
}

export function resolveOpenTabForSessionId(
  args: OpenTabResolutionArgs
): AiVaultSessionOpenTab | null {
  return (
    openTabFromMobileSnapshots(args) ??
    openTabFromLeaves(args) ??
    openTabFromPersistedTabs(args) ??
    openTabFromUnifiedTabs(args)
  )
}

function matchesSessionId(candidate: string | null | undefined, target: string): boolean {
  if (candidate === target) {
    return true
  }
  if (!candidate || (!candidate.includes(':') && !target.includes(':'))) {
    return false
  }
  return candidate.split(':').at(-1) === target.split(':').at(-1)
}

function openTab(worktreeId: string, tabId: string, leafId?: string): AiVaultSessionOpenTab {
  return leafId ? { worktreeId, tabId, leafId } : { worktreeId, tabId }
}

function sessionIdForTerminalTab(
  args: OpenTabResolutionArgs,
  tab: Extract<RuntimeMobileSessionSnapshotTab, { type: 'terminal' }>,
  topTabId: string
): string | null | undefined {
  const fromStatus = 'agentStatus' in tab ? tab.agentStatus?.providerSession?.id : undefined
  return (
    fromStatus ??
    (tab.ptyId ? args.ptysById.get(tab.ptyId)?.providerSessionId : undefined) ??
    args.tabs.get(topTabId)?.aiVaultTitle?.sessionId ??
    resolveSessionIdForTabFromState(args, topTabId)
  )
}

function openTabFromMobileSnapshots(args: OpenTabResolutionArgs): AiVaultSessionOpenTab | null {
  for (const [worktreeKey, snapshot] of args.mobileSessionTabsByWorktree) {
    const worktreeId = snapshot.worktree || worktreeKey
    for (const tab of snapshot.tabs) {
      if (tab.type === 'agent-session') {
        if (matchesSessionId(tab.sessionId, args.sessionId)) {
          return openTab(worktreeId, tab.id)
        }
        continue
      }
      if (tab.type !== 'terminal') {
        continue
      }
      const topTabId = tab.parentTabId || tab.id
      if (matchesSessionId(sessionIdForTerminalTab(args, tab, topTabId), args.sessionId)) {
        return openTab(worktreeId, topTabId, tab.leafId)
      }
    }
  }
  return null
}

function leafStillListed(args: OpenTabResolutionArgs, leaf: RuntimeSyncedLeaf): boolean {
  if (!args.mobileSessionTabsByWorktree.has(leaf.worktreeId)) {
    return true
  }
  const snap = args.mobileSessionTabsByWorktree.get(leaf.worktreeId)
  return (
    snap?.tabs.some(
      (tab) => tab.id === leaf.tabId || (tab.type === 'terminal' && tab.parentTabId === leaf.tabId)
    ) ?? false
  )
}

function openTabFromLeaves(args: OpenTabResolutionArgs): AiVaultSessionOpenTab | null {
  for (const leaf of args.leaves.values()) {
    if (!leaf.worktreeId || !leaf.tabId || !leafStillListed(args, leaf)) {
      continue
    }
    const resolvedId =
      (leaf.ptyId ? args.ptysById.get(leaf.ptyId)?.providerSessionId : undefined) ??
      args.tabs.get(leaf.tabId)?.aiVaultTitle?.sessionId ??
      resolveSessionIdForTabFromState(args, leaf.tabId)
    if (matchesSessionId(resolvedId, args.sessionId)) {
      return openTab(leaf.worktreeId, leaf.tabId, leaf.leafId)
    }
  }
  return null
}

function openTabFromPersistedTabs(args: OpenTabResolutionArgs): AiVaultSessionOpenTab | null {
  const session = args.session
  if (!session) {
    return null
  }
  for (const [worktreeId, worktreeTabs] of Object.entries(session.tabsByWorktree ?? {})) {
    if (args.mobileSessionTabsByWorktree.has(worktreeId)) {
      continue
    }
    for (const tab of worktreeTabs ?? []) {
      const resolvedId =
        tab.aiVaultTitle?.sessionId ??
        (tab.ptyId ? args.ptysById.get(tab.ptyId)?.providerSessionId : undefined) ??
        resolvePersistedSessionIdForTab(session, tab.id) ??
        args.statusRows.find(
          (row) =>
            (row.tabId === tab.id || parseTabIdFromPaneKey(row.paneKey) === tab.id) &&
            row.providerSession?.id
        )?.providerSession?.id
      if (matchesSessionId(resolvedId, args.sessionId)) {
        return openTab(worktreeId, tab.id)
      }
    }
  }
  return null
}

function openTabFromUnifiedTabs(args: OpenTabResolutionArgs): AiVaultSessionOpenTab | null {
  const session = args.session
  if (!session?.unifiedTabs) {
    return null
  }
  for (const [worktreeId, unifiedTabs] of Object.entries(session.unifiedTabs)) {
    if (args.mobileSessionTabsByWorktree.has(worktreeId)) {
      continue
    }
    for (const uTab of unifiedTabs ?? []) {
      const resolvedId =
        (uTab.contentType === 'agent-session' ? uTab.entityId : undefined) ??
        uTab.aiVaultTitle?.sessionId
      if (matchesSessionId(resolvedId, args.sessionId)) {
        return openTab(worktreeId, uTab.id)
      }
    }
  }
  return null
}
