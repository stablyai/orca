import { stripLeadingAgentTitleDecorationOrEmpty } from '../../../src/shared/agent-title-decoration'
import { resolveExplicitTerminalTitleAgentType } from '../../../src/shared/terminal-title-agent-type'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isBlankBrowserUrl } from '../browser/browser-url'
import { agentDotState, type AgentDotState } from '../worktree/agent-row-display'
import type { MobileSessionTab, MobileSessionTabType } from './mobile-session-route-types'

// Why: tab identity + title cleaning uses the same shared glyph/label maps as
// desktop, so the two platforms do not drift on which titles identify agents.

/**
 * Resolve which coding agent a mobile terminal tab is running, for its tab
 * icon. Hook-reported `agentType` is the authoritative signal; the OSC title is
 * the fallback for sessions without hook status or a host launch identity.
 * Returns null when no agent is identified (plain shell / unknown), so the tab
 * keeps its text-only label.
 */
type MobileTerminalTabAgentIdentity = {
  title: string
  agentStatus?: { agentType?: AgentStatusEntry['agentType'] | null } | null
  launchAgent?: TuiAgent | null
}

/** The host's own pane identity for a terminal tab, as `terminal.list` last reported it. */
export function getMobileTerminalTabHostAgentIdentity(
  tab: MobileSessionTab,
  terminals: readonly { handle: string; agentIdentity?: string }[]
): string | undefined {
  if (tab.type !== 'terminal' || !tab.terminal) {
    return undefined
  }
  return terminals.find((terminal) => terminal.handle === tab.terminal)?.agentIdentity
}

// Cursor imports Claude hooks, so its host identity corrects that hook misattribution.
export function resolveMobileTerminalTabOwnedAgentId(
  tab: MobileTerminalTabAgentIdentity,
  hostAgentIdentity?: string | null
): string | null {
  const hookAgentType = tab.agentStatus?.agentType?.trim()
  if (hookAgentType && hookAgentType !== 'unknown') {
    return hookAgentType === 'claude' && hostAgentIdentity === 'cursor' ? 'cursor' : hookAgentType
  }
  if (tab.launchAgent) {
    return tab.launchAgent
  }
  return null
}

export function resolveMobileTerminalTabAgentId(
  tab: MobileTerminalTabAgentIdentity,
  hostAgentIdentity?: string | null
): string | null {
  const ownedAgent = resolveMobileTerminalTabOwnedAgentId(tab, hostAgentIdentity)
  if (ownedAgent) {
    return ownedAgent
  }
  if (hostAgentIdentity === 'cursor') {
    return 'cursor'
  }
  return resolveExplicitTerminalTitleAgentType(tab.title)
}

export function getMobileSessionTabTitle(
  tab: MobileSessionTab,
  hostAgentIdentity?: string | null
): string {
  if (tab.type === 'browser') {
    const title = tab.title.trim()
    if (title && !isBlankBrowserUrl(title)) {
      return title
    }
    if (isBlankBrowserUrl(tab.url)) {
      return 'New Browser'
    }
    return 'Browser'
  }
  if (tab.type === 'markdown') {
    return tab.title || 'Markdown'
  }
  if (tab.type === 'file') {
    return tab.title || 'File'
  }
  if (tab.type === 'agent-session') {
    return tab.title || 'Chat'
  }
  // Why: strip the leading agent status glyph (✳ etc.) once the tab shows the
  // provider icon. Mobile falls back for glyph-only titles because iOS can
  // render the bare status glyph as a stray colored box beside the icon.
  if (resolveMobileTerminalTabAgentId(tab, hostAgentIdentity)) {
    return stripLeadingAgentTitleDecorationOrEmpty(tab.title) || 'Terminal'
  }
  return tab.title || 'Terminal'
}

const VALID_AGENT_DOT_STATES = new Set<string>([
  'working',
  'monitoring',
  'blocked',
  'waiting',
  'done',
  'interrupted',
  'failed',
  'unconfirmed'
])

export function parseAgentDotState(raw: unknown): AgentDotState | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: guarded by VALID_AGENT_DOT_STATES.has(raw).
  return typeof raw === 'string' && VALID_AGENT_DOT_STATES.has(raw)
    ? (raw as AgentDotState)
    : undefined
}

export function resolveMobileSessionTabDotState(
  tab: {
    type?: MobileSessionTab['type']
    agentStatus?: (AgentStatusEntry & { restoredUnconfirmed?: boolean }) | null
    chatStatus?: Extract<MobileSessionTab, { type: 'agent-session' }>['chatStatus'] | null
  },
  now = Date.now()
): AgentDotState | undefined {
  // Why: a status restored across a host restart is unconfirmed, so like desktop it shows no live state.
  if (tab.type === 'terminal' && tab.agentStatus && !tab.agentStatus.restoredUnconfirmed) {
    return agentDotState(tab.agentStatus, now)
  }
  if (tab.type === 'agent-session' && tab.chatStatus) {
    return agentDotState(tab.chatStatus, now)
  }
  return undefined
}

export type LiveRecentCardTab = {
  id: string
  terminal?: string | null
  type?: MobileSessionTab['type']
  agentStatus?: (AgentStatusEntry & { restoredUnconfirmed?: boolean }) | null
  chatStatus?: Extract<MobileSessionTab, { type: 'agent-session' }>['chatStatus'] | null
  agentState?: AgentDotState | null
}

export function resolveLiveTabDotState(
  tab: LiveRecentCardTab | undefined,
  fallbackState: AgentDotState | undefined
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
  const resolved =
    tab.agentState !== undefined
      ? tab.agentState
      : tab.type
        ? resolveMobileSessionTabDotState(tab)
        : undefined
  return resolved && resolved !== 'idle' ? resolved : undefined
}

export function syncRecentCardWithLiveTab(
  card: RecentSessionCardSnapshot,
  tab: LiveRecentCardTab | undefined
): RecentSessionCardSnapshot {
  const nextState = resolveLiveTabDotState(tab, card.agentState)
  if (card.agentState === nextState) {
    return card
  }
  const { agentState: _omit, ...rest } = card
  return nextState ? { ...rest, agentState: nextState } : rest
}

function resolveSnapshotSessionTabDotState(
  item: Record<string, unknown>,
  now = Date.now()
): AgentDotState | null {
  const raw =
    item.type === 'terminal'
      ? item.agentStatus
      : item.type === 'agent-session'
        ? item.chatStatus
        : null
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('state' in raw) ||
    typeof raw.state !== 'string' ||
    !('updatedAt' in raw) ||
    typeof raw.updatedAt !== 'number'
  ) {
    return null
  }
  if (
    item.type === 'terminal' &&
    'restoredUnconfirmed' in raw &&
    raw.restoredUnconfirmed === true
  ) {
    return 'idle'
  }
  if (
    raw.state !== 'working' &&
    raw.state !== 'blocked' &&
    raw.state !== 'waiting' &&
    raw.state !== 'done'
  ) {
    return 'idle'
  }
  return agentDotState(
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
  )
}

export function recentCardSnapshotTabs(
  value: unknown
): { id: string; terminal?: string | null; agentState?: AgentDotState | null }[] | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('tabs' in value) ||
    !Array.isArray(value.tabs)
  ) {
    return null
  }
  return value.tabs.flatMap((item) =>
    typeof item === 'object' &&
    item !== null &&
    'id' in item &&
    typeof item.id === 'string' &&
    item.id.length > 0
      ? [
          {
            id: item.id,
            terminal:
              'terminal' in item && (typeof item.terminal === 'string' || item.terminal === null)
                ? item.terminal
                : undefined,
            agentState: resolveSnapshotSessionTabDotState(item)
          }
        ]
      : []
  )
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

export function buildRecentSessionCardFromTab(p: {
  hostId: string
  worktreeId: string
  worktreeName: string
  tab: MobileSessionTab
  now?: number
}): RecentSessionCardSnapshot {
  const { hostId, worktreeId, worktreeName, tab: t } = p
  const now = p.now ?? Date.now()
  const agentId =
    t.type === 'agent-session'
      ? t.agent
      : t.type === 'terminal'
        ? resolveMobileTerminalTabAgentId(t)
        : undefined
  const rawState = resolveMobileSessionTabDotState(t, now)
  const agentState = rawState && rawState !== 'idle' ? rawState : undefined
  const leafId = t.type === 'terminal' && t.leafId ? t.leafId : undefined
  const terminalHandle = t.type === 'terminal' && t.terminal ? t.terminal : undefined
  const base = { hostId, worktreeId, worktreeName, tabId: t.id, title: getMobileSessionTabTitle(t) }
  const rest = { tabType: t.type, lastVisitedAt: now }
  return Object.assign(
    base,
    rest,
    agentId && { agentId },
    agentState && { agentState },
    leafId && { leafId },
    terminalHandle && { terminalHandle }
  )
}
