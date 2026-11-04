import type { AgentStatusEntry } from '../../../src/shared/agent-status/contracts/agent-status-types'
import { agentDotState, type AgentDotState } from '../worktree/agent-row-display'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  buildTabCompletionKeys,
  reconcileTerminalAgentStatusWithCatalog,
  resolveTrackedTabCompletionState
} from './session-tab-catalog-agent-status'
import {
  clearLatchedUnreadTabKeys,
  consumeWorktreeUnreadForTabCompletion,
  hasUnacknowledgedTabCompletion,
  recordCatalogAgentTabState,
  restoreLatchedUnreadTabKeys,
  setLatchedUnreadTabKeys
} from './tab-completion-state'

export { clearLatchedUnreadTabKeys, restoreLatchedUnreadTabKeys }

type SessionTabPaneIdentity = {
  id?: string
  parentTabId?: string | null
  leafId?: string | null
  agentStatus?: { paneKey?: string | null } | null
}

export function resolveSessionTabPaneKey(
  tab: SessionTabPaneIdentity,
  tabId = tab.id
): string | null {
  if (tab.agentStatus?.paneKey) {
    return tab.agentStatus.paneKey
  }
  if (tab.parentTabId && tab.leafId) {
    return `${tab.parentTabId}:${tab.leafId}`
  }
  if (tabId && tab.leafId && !tabId.includes('::')) {
    return `${tabId}:${tab.leafId}`
  }
  if (tabId?.includes('::')) {
    return tabId.replace('::', ':')
  }
  return null
}

type SessionTabStatus = {
  id?: string
  parentTabId?: string | null
  leafId?: string | null
  terminal?: string | null
  isActive?: boolean
  type?: MobileSessionTab['type']
  agentStatus?: (AgentStatusEntry & { restoredUnconfirmed?: boolean }) | null
  chatStatus?: Extract<MobileSessionTab, { type: 'agent-session' }>['chatStatus'] | null
}

export function resolveRawSessionTabDotState(
  tab: SessionTabStatus,
  now = Date.now(),
  tabId = tab.id
): AgentDotState | undefined {
  if (tab.type === 'terminal') {
    const status = reconcileTerminalAgentStatusWithCatalog(tab.agentStatus, {
      tabId,
      parentTabId: tab.parentTabId,
      leafId: tab.leafId,
      now
    })
    // Why: a status restored across a host restart is unconfirmed, so like desktop it shows no live state.
    if (status && !status.restoredUnconfirmed) {
      return agentDotState(status, now)
    }
    return undefined
  }
  if (tab.type === 'agent-session' && tab.chatStatus) {
    return agentDotState(tab.chatStatus, now)
  }
  return undefined
}

export function resolveTabDoneStamp(tab: SessionTabStatus, tabId = tab.id): number | undefined {
  if (tab.type === 'terminal') {
    const status = reconcileTerminalAgentStatusWithCatalog(tab.agentStatus, {
      tabId,
      parentTabId: tab.parentTabId,
      leafId: tab.leafId
    })
    return status ? (status.stateStartedAt ?? status.updatedAt) : undefined
  }
  if (tab.type === 'agent-session' && tab.chatStatus) {
    return tab.chatStatus.updatedAt
  }
  return undefined
}

export function resolveMobileSessionTabDotState(
  tab: SessionTabStatus,
  now = Date.now(),
  options?: { isActiveOnScreen?: boolean; tabId?: string }
): AgentDotState | undefined {
  const tabId = options?.tabId ?? tab.id
  const rawState = resolveRawSessionTabDotState(tab, now, tabId)
  return resolveTrackedTabCompletionState({
    keys: buildTabCompletionKeys({
      id: tabId,
      terminal: tab.terminal,
      paneKey: resolveSessionTabPaneKey(tab, tabId)
    }),
    rawState,
    doneStamp: resolveTabDoneStamp(tab, tabId),
    isActiveOnScreen: options?.isActiveOnScreen ?? tab.isActive
  })
}

export function isMobileSessionTabUnreadBeforeView(
  tab: SessionTabStatus,
  now = Date.now(),
  tabId = tab.id
): boolean {
  const rawState = resolveRawSessionTabDotState(tab, now, tabId)
  return hasUnacknowledgedTabCompletion(
    buildTabCompletionKeys({
      id: tabId,
      terminal: tab.terminal,
      paneKey: resolveSessionTabPaneKey(tab, tabId)
    }),
    rawState
  )
}

export function latchInitialActiveTabUnread(tab: SessionTabStatus, tabId = tab.id): void {
  setLatchedUnreadTabKeys(
    buildTabCompletionKeys({
      id: tabId,
      terminal: tab.terminal,
      paneKey: resolveSessionTabPaneKey(tab, tabId)
    })
  )
}

export function seedUnreadWorktreeSessionTabs(
  worktreeId: string | null | undefined,
  tabs: readonly MobileSessionTab[],
  now = Date.now()
): void {
  if (tabs.length === 0 || !consumeWorktreeUnreadForTabCompletion(worktreeId)) {
    return
  }
  for (const tab of tabs) {
    if (isMobileSessionTabUnreadBeforeView(tab, now)) {
      return
    }
  }
  let best: { keys: string[]; stamp: number; isActive: boolean } | null = null
  for (const tab of tabs) {
    if (resolveRawSessionTabDotState(tab, now) !== 'done') {
      continue
    }
    const stamp = resolveTabDoneStamp(tab) ?? -Infinity
    const isActive = tab.isActive === true
    if (!best || stamp > best.stamp || (stamp === best.stamp && isActive && !best.isActive)) {
      best = {
        keys: buildTabCompletionKeys({
          id: tab.id,
          terminal: tab.type === 'terminal' ? tab.terminal : undefined,
          paneKey: resolveSessionTabPaneKey(tab)
        }),
        stamp,
        isActive
      }
    }
  }
  if (!best) {
    return
  }
  recordCatalogAgentTabState({
    keys: best.keys,
    rawState: 'done',
    doneStamp: Number.isFinite(best.stamp) ? best.stamp : undefined,
    forceUnreadIfUnacknowledged: true
  })
}
