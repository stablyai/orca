import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import { agentDotState, type AgentDotState } from '../worktree/agent-row-display'
import type { MobileSessionTab, MobileSessionTabType } from './mobile-session-route-types'
import {
  buildTabCompletionKeys,
  getMobileSessionTabTitle,
  resolveMobileSessionTabDotState,
  resolveMobileTerminalTabAgentId,
  resolveRawSessionTabDotState,
  resolveTabDoneStamp,
  resolveTrackedTabCompletionState
} from './mobile-terminal-tab-agent'
import { reconcileTerminalAgentStatusWithCatalog } from './session-tab-catalog-agent-status'

export type LiveRecentCardTab = {
  id: string
  terminal?: string | null
  isActive?: boolean
  type?: MobileSessionTab['type']
  agentStatus?: (AgentStatusEntry & { restoredUnconfirmed?: boolean }) | null
  chatStatus?: Extract<MobileSessionTab, { type: 'agent-session' }>['chatStatus'] | null
  agentState?: AgentDotState | null
  doneStamp?: number
}

export type RecentSessionCardSnapshot = {
  hostId: string
  worktreeId: string
  worktreeName: string
  tabId: string
  leafId?: string
  terminalHandle?: string
  title: string
  tabType: MobileSessionTabType
  agentId?: string
  agentState?: AgentDotState
  lastVisitedAt: number
}

export function resolveLiveTabDotState(
  tab: LiveRecentCardTab | undefined,
  fallbackState: AgentDotState | undefined,
  options?: { card?: RecentSessionCardSnapshot; isActiveOnScreen?: boolean }
): AgentDotState | undefined {
  if (
    !tab ||
    (tab.agentState === undefined &&
      tab.type === undefined &&
      tab.agentStatus === undefined &&
      tab.chatStatus === undefined)
  ) {
    return fallbackState
  }
  const rawState =
    tab.agentState !== undefined
      ? (tab.agentState ?? undefined)
      : tab.type
        ? resolveRawSessionTabDotState(tab)
        : undefined
  const resolved = resolveTrackedTabCompletionState({
    keys: buildTabCompletionKeys({
      id: tab.id || options?.card?.tabId,
      terminal: tab.terminal ?? options?.card?.terminalHandle,
      paneKey: tab.agentStatus?.paneKey
    }),
    rawState,
    doneStamp: tab.doneStamp ?? resolveTabDoneStamp(tab),
    isActiveOnScreen: options?.isActiveOnScreen ?? tab.isActive,
    previousCardState: fallbackState
  })
  return resolved && resolved !== 'idle' ? resolved : undefined
}

export function syncRecentCardWithLiveTab(
  card: RecentSessionCardSnapshot,
  tab: LiveRecentCardTab | undefined,
  options?: { isActiveOnScreen?: boolean }
): RecentSessionCardSnapshot {
  const nextState = resolveLiveTabDotState(tab, card.agentState, {
    card,
    isActiveOnScreen: options?.isActiveOnScreen
  })
  if (card.agentState === nextState) {
    return card
  }
  const { agentState: _omit, ...rest } = card
  return nextState ? { ...rest, agentState: nextState } : rest
}

function resolveSnapshotSessionTabDotState(
  item: Record<string, unknown>,
  now = Date.now(),
  options?: { worktreeId?: string; worktrees?: readonly unknown[] }
): { agentState: AgentDotState | null; doneStamp?: number } {
  if (item.type === 'terminal') {
    const status = reconcileTerminalAgentStatusWithCatalog(item.agentStatus, {
      worktreeId: options?.worktreeId,
      worktrees: options?.worktrees,
      tabId: typeof item.id === 'string' ? item.id : null,
      parentTabId: typeof item.parentTabId === 'string' ? item.parentTabId : null,
      leafId: typeof item.leafId === 'string' ? item.leafId : null,
      now
    })
    if (!status) {
      return { agentState: null }
    }
    if (status.restoredUnconfirmed === true) {
      return { agentState: 'idle' }
    }
    return {
      agentState: agentDotState({ ...status, mirroredEvidenceReceivedAt: now }, now),
      doneStamp: status.stateStartedAt ?? status.updatedAt
    }
  }
  const raw = item.type === 'agent-session' ? item.chatStatus : null
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('state' in raw) ||
    typeof raw.state !== 'string' ||
    !('updatedAt' in raw) ||
    typeof raw.updatedAt !== 'number'
  ) {
    return { agentState: null }
  }
  if (
    raw.state !== 'working' &&
    raw.state !== 'blocked' &&
    raw.state !== 'waiting' &&
    raw.state !== 'done'
  ) {
    return { agentState: 'idle' }
  }
  const doneStamp =
    'stateStartedAt' in raw && typeof raw.stateStartedAt === 'number'
      ? raw.stateStartedAt
      : raw.updatedAt
  return {
    agentState: agentDotState(
      {
        state: raw.state,
        updatedAt: raw.updatedAt,
        mirroredEvidenceReceivedAt: now,
        workingMode:
          'workingMode' in raw && raw.workingMode === 'monitoring' ? 'monitoring' : undefined,
        interrupted:
          'interrupted' in raw && typeof raw.interrupted === 'boolean' ? raw.interrupted : undefined
      },
      now
    ),
    doneStamp
  }
}

export function recentCardSnapshotTabs(
  value: unknown,
  options?: { worktreeId?: string; worktrees?: readonly unknown[] }
):
  | {
      id: string
      terminal?: string | null
      agentState?: AgentDotState | null
      doneStamp?: number
    }[]
  | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('tabs' in value) ||
    !Array.isArray(value.tabs)
  ) {
    return null
  }
  return value.tabs.flatMap((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('id' in item) ||
      typeof item.id !== 'string' ||
      item.id.length === 0
    ) {
      return []
    }
    const { agentState, doneStamp } = resolveSnapshotSessionTabDotState(item, Date.now(), options)
    return [
      {
        id: item.id,
        terminal:
          'terminal' in item && (typeof item.terminal === 'string' || item.terminal === null)
            ? item.terminal
            : undefined,
        agentState,
        ...(doneStamp !== undefined ? { doneStamp } : {})
      }
    ]
  })
}

export function buildRecentSessionCardFromTab(p: {
  hostId: string
  worktreeId: string
  worktreeName: string
  tab: MobileSessionTab
  hostAgentIdentity?: string | null
  now?: number
}): RecentSessionCardSnapshot {
  const { hostId, worktreeId, worktreeName, tab: t, hostAgentIdentity } = p
  const now = p.now ?? Date.now()
  const agentId =
    t.type === 'agent-session'
      ? t.agent
      : t.type === 'terminal'
        ? resolveMobileTerminalTabAgentId(t, hostAgentIdentity)
        : undefined
  const rawState = resolveMobileSessionTabDotState(t, now)
  const agentState = rawState && rawState !== 'idle' ? rawState : undefined
  const leafId = t.type === 'terminal' && t.leafId ? t.leafId : undefined
  const terminalHandle = t.type === 'terminal' && t.terminal ? t.terminal : undefined
  return {
    hostId,
    worktreeId,
    worktreeName,
    tabId: t.id,
    title: getMobileSessionTabTitle(t, hostAgentIdentity),
    tabType: t.type,
    lastVisitedAt: now,
    ...(agentId ? { agentId } : {}),
    ...(agentState ? { agentState } : {}),
    ...(leafId ? { leafId } : {}),
    ...(terminalHandle ? { terminalHandle } : {})
  }
}
