import { stripLeadingAgentTitleDecorationOrEmpty } from '../../../src/shared/agent-title-decoration'
import { resolveExplicitTerminalTitleAgentType } from '../../../src/shared/terminal-title-agent-type'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isBlankBrowserUrl } from '../browser/browser-url'
import { agentDotState, type AgentDotState } from '../worktree/agent-row-display'
import type { MobileSessionTab } from './mobile-session-route-types'

export {
  buildRecentSessionCardFromTab,
  recentCardSnapshotTabs,
  resolveLiveTabDotState,
  syncRecentCardWithLiveTab,
  type LiveRecentCardTab,
  type RecentSessionCardSnapshot
} from './recent-session-card-snapshot'

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

const VALID_AGENT_DOT_STATES: readonly AgentDotState[] = [
  'working',
  'monitoring',
  'blocked',
  'waiting',
  'unread',
  'done',
  'interrupted',
  'failed',
  'unconfirmed'
]

export function parseAgentDotState(raw: unknown): AgentDotState | undefined {
  return typeof raw === 'string' ? VALID_AGENT_DOT_STATES.find((state) => state === raw) : undefined
}

type TabCompletionTrackerEntry = {
  sawInTurn: boolean
  unread: boolean
  acknowledgedDoneAt?: number
}

const tabCompletionTracker = new Map<string, TabCompletionTrackerEntry>()

export function clearTabCompletionTrackerForTests(): void {
  tabCompletionTracker.clear()
}

function isInTurnDotState(state: AgentDotState | null | undefined): boolean {
  return state === 'working' || state === 'monitoring' || state === 'waiting' || state === 'blocked'
}

function getOrCreateTrackerEntry(keys: readonly string[]): TabCompletionTrackerEntry | null {
  if (keys.length === 0) {
    return null
  }
  let existing: TabCompletionTrackerEntry | undefined
  for (const key of keys) {
    existing = tabCompletionTracker.get(key)
    if (existing) {
      break
    }
  }
  const entry = existing ?? { sawInTurn: false, unread: false }
  for (const key of keys) {
    tabCompletionTracker.set(key, entry)
  }
  return entry
}

export function buildTabCompletionKeys(args: {
  id?: string | null
  terminal?: string | null
  paneKey?: string | null
}): string[] {
  const keys: string[] = []
  if (args.id) {
    keys.push(`tab:${args.id}`)
  }
  if (args.terminal) {
    keys.push(`pty:${args.terminal}`)
  }
  if (args.paneKey) {
    keys.push(`pane:${args.paneKey}`)
  }
  return keys
}

export function resolveTrackedTabCompletionState(args: {
  keys: readonly string[]
  rawState: AgentDotState | undefined
  doneStamp?: number
  isActiveOnScreen?: boolean
  previousCardState?: AgentDotState
}): AgentDotState | undefined {
  const { keys, rawState, doneStamp, isActiveOnScreen, previousCardState } = args
  const entry = getOrCreateTrackerEntry(keys)
  if (!entry) {
    return rawState
  }
  if (
    previousCardState === 'unread' &&
    !entry.sawInTurn &&
    !entry.unread &&
    entry.acknowledgedDoneAt === undefined
  ) {
    entry.unread = true
  }
  if (isInTurnDotState(previousCardState) && rawState === 'done' && isActiveOnScreen === false) {
    entry.sawInTurn = true
  }
  if (isInTurnDotState(rawState)) {
    entry.sawInTurn = true
    entry.unread = false
    return rawState
  }
  if (rawState === 'done') {
    const hasUnacknowledgedCompletion = entry.unread || entry.sawInTurn
    if (isActiveOnScreen === true) {
      entry.sawInTurn = false
      entry.unread = false
      if (doneStamp !== undefined) {
        entry.acknowledgedDoneAt = Math.max(entry.acknowledgedDoneAt ?? 0, doneStamp)
      }
      return 'done'
    }
    if (isActiveOnScreen === false) {
      if (hasUnacknowledgedCompletion) {
        entry.sawInTurn = false
        entry.unread = true
        return 'unread'
      }
      if (doneStamp !== undefined && entry.acknowledgedDoneAt === undefined) {
        entry.acknowledgedDoneAt = doneStamp
      }
      return 'done'
    }
    if (entry.unread) {
      return 'unread'
    }
    if (entry.sawInTurn) {
      entry.sawInTurn = false
      entry.unread = true
      return 'unread'
    }
    if (doneStamp !== undefined && entry.acknowledgedDoneAt === undefined) {
      entry.acknowledgedDoneAt = doneStamp
    }
    return 'done'
  }
  if (rawState === 'interrupted' || rawState === 'failed') {
    entry.sawInTurn = false
    entry.unread = false
  }
  return rawState
}

export function resolveRawSessionTabDotState(
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

export function resolveTabDoneStamp(tab: {
  type?: MobileSessionTab['type']
  agentStatus?: (AgentStatusEntry & { restoredUnconfirmed?: boolean }) | null
  chatStatus?: Extract<MobileSessionTab, { type: 'agent-session' }>['chatStatus'] | null
}): number | undefined {
  if (tab.type === 'terminal' && tab.agentStatus) {
    return tab.agentStatus.stateStartedAt ?? tab.agentStatus.updatedAt
  }
  if (tab.type === 'agent-session' && tab.chatStatus) {
    return tab.chatStatus.updatedAt
  }
  return undefined
}

export function resolveMobileSessionTabDotState(
  tab: {
    id?: string
    terminal?: string | null
    isActive?: boolean
    type?: MobileSessionTab['type']
    agentStatus?: (AgentStatusEntry & { restoredUnconfirmed?: boolean }) | null
    chatStatus?: Extract<MobileSessionTab, { type: 'agent-session' }>['chatStatus'] | null
  },
  now = Date.now(),
  options?: { isActiveOnScreen?: boolean }
): AgentDotState | undefined {
  const rawState = resolveRawSessionTabDotState(tab, now)
  return resolveTrackedTabCompletionState({
    keys: buildTabCompletionKeys({
      id: tab.id,
      terminal: tab.terminal,
      paneKey: tab.agentStatus?.paneKey
    }),
    rawState,
    doneStamp: resolveTabDoneStamp(tab),
    isActiveOnScreen: options?.isActiveOnScreen ?? tab.isActive
  })
}
