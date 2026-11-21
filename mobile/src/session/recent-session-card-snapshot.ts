import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../src/shared/remote-runtime/session-graph/runtime-session-contracts'
import type {
  AgentStatusEntry,
  AgentStatusState
} from '../../../src/shared/agent-status/contracts/agent-status-types'
import { agentDotState, type AgentDotState } from '../worktree/agent-lineage/agent-row-display'
import { mobileSessionTabDotState } from './tabs/mobile-session-tab-rows'
import type { MobileSessionTab, MobileSessionTabType } from './tabs/mobile-session-tabs'
import {
  getMobileSessionTabTitle,
  resolveMobileTerminalTabAgentId
} from './tabs/mobile-terminal-tab-agent'

export type RecentSessionCardSnapshot = {
  hostId: string
  worktreeId: string
  worktreeName: string
  tabId: string
  leafId?: string
  terminalHandle?: string
  sessionId?: string
  title: string
  tabType: MobileSessionTabType
  agentId?: string
  agentState?: AgentDotState
  /** Transient host unread verdict projected from live `tab.unread`; never persisted to storage. */
  unread?: boolean
  lastVisitedAt: number
}

export type LiveRecentCardTab = {
  id: string
  terminal?: string | null
  sessionId?: string | null
  isActive?: boolean
  type?: MobileSessionTab['type']
  agentState?: AgentDotState | null
  unread?: boolean
  agentStatus?: (AgentStatusEntry & { restoredUnconfirmed?: boolean }) | null
  chatStatus?: Extract<MobileSessionTab, { type: 'agent-session' }>['chatStatus'] | null
}

const VALID_AGENT_DOT_STATES: readonly AgentDotState[] = [
  'working',
  'monitoring',
  'blocked',
  'waiting',
  'done',
  'interrupted',
  'failed',
  'unconfirmed',
  'unverifiable',
  'permission'
]

export function parseAgentDotState(raw: unknown): AgentDotState | undefined {
  return typeof raw === 'string' ? VALID_AGENT_DOT_STATES.find((state) => state === raw) : undefined
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function parseStatusState(v: unknown): AgentStatusState | null {
  return v === 'working' || v === 'blocked' || v === 'waiting' || v === 'done' ? v : null
}

export function isUnpublishedSnapshot(snapshot: unknown): boolean {
  return isRecord(snapshot) && snapshot.publicationEpoch === UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH
}

export function resolveLiveTabDotState(
  tab: LiveRecentCardTab | undefined,
  fallbackState: AgentDotState | undefined,
  now = Date.now()
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
  if (tab.agentState !== undefined) {
    return tab.agentState && tab.agentState !== 'idle' ? tab.agentState : undefined
  }
  let dot: AgentDotState | undefined
  if (tab.type === 'terminal' && tab.agentStatus && !tab.agentStatus.restoredUnconfirmed) {
    dot = agentDotState(tab.agentStatus, now)
  } else if (tab.type === 'agent-session' && tab.chatStatus) {
    dot = agentDotState(tab.chatStatus, now)
  }
  return dot && dot !== 'idle' ? dot : undefined
}

export function syncRecentCardWithLiveTab(
  card: RecentSessionCardSnapshot,
  tab: LiveRecentCardTab | undefined
): RecentSessionCardSnapshot {
  const nextState = resolveLiveTabDotState(tab, card.agentState)
  const nextUnread = tab ? (tab.unread === true ? true : undefined) : card.unread
  if (card.agentState === nextState && card.unread === nextUnread) {
    return card
  }
  const { agentState: _omitState, unread: _omitUnread, ...rest } = card
  return {
    ...rest,
    ...(nextState ? { agentState: nextState } : {}),
    ...(nextUnread ? { unread: true } : {})
  }
}

function resolveSnapshotItemDotState(
  item: Record<string, unknown>,
  now: number
): AgentDotState | null {
  const raw =
    item.type === 'terminal'
      ? item.agentStatus
      : item.type === 'agent-session'
        ? item.chatStatus
        : null
  if (!isRecord(raw)) {
    return null
  }
  if (item.type === 'terminal' && raw.restoredUnconfirmed === true) {
    return 'idle'
  }
  const state = parseStatusState(raw.state)
  if (!state || typeof raw.updatedAt !== 'number') {
    return item.type === 'agent-session' && typeof raw.state === 'string' ? 'idle' : null
  }
  return agentDotState(
    {
      state,
      updatedAt: raw.updatedAt,
      ...(raw.workingMode === 'monitoring' ? { workingMode: 'monitoring' as const } : {}),
      ...(typeof raw.interrupted === 'boolean' ? { interrupted: raw.interrupted } : {}),
      ...(raw.hasLivePty === true ? { hasLivePty: true as const } : {}),
      ...(typeof raw.evidenceObservedAt === 'number'
        ? { evidenceObservedAt: raw.evidenceObservedAt }
        : {}),
      ...(typeof raw.mirroredEvidenceReceivedAt === 'number'
        ? { mirroredEvidenceReceivedAt: raw.mirroredEvidenceReceivedAt }
        : {})
    },
    now
  )
}

export function recentCardSnapshotTabs(
  value: unknown,
  now = Date.now()
):
  | {
      id: string
      terminal?: string | null
      sessionId?: string | null
      agentState?: AgentDotState | null
      unread?: boolean
    }[]
  | null {
  if (!isRecord(value) || !Array.isArray(value.tabs)) {
    return null
  }
  return value.tabs.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) {
      return []
    }
    const agentState = resolveSnapshotItemDotState(item, now)
    const sessionId =
      typeof item.sessionId === 'string' && item.sessionId.length > 0 ? item.sessionId : undefined
    const unread =
      (item.type === 'terminal' || item.type === 'agent-session') && item.unread === true
    return [
      {
        id: item.id,
        terminal:
          typeof item.terminal === 'string' || item.terminal === null ? item.terminal : undefined,
        ...(sessionId ? { sessionId } : {}),
        agentState,
        unread
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
  const rawState = mobileSessionTabDotState(t, now)
  const agentState = rawState && rawState !== 'idle' ? rawState : undefined
  const leafId = t.type === 'terminal' && t.leafId ? t.leafId : undefined
  const terminalHandle = t.type === 'terminal' && t.terminal ? t.terminal : undefined
  const sessionId = t.type === 'agent-session' && t.sessionId ? t.sessionId : undefined
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
    ...(terminalHandle ? { terminalHandle } : {}),
    ...(sessionId ? { sessionId } : {})
  }
}
