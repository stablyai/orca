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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseAgentDotState(raw: unknown): AgentDotState | undefined {
  return typeof raw === 'string'
    ? VALID_AGENT_DOT_STATES.find((state) => state === raw)
    : undefined
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
  return (
    state === 'working' || state === 'monitoring' || state === 'waiting' || state === 'blocked'
  )
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

function buildTabCompletionKeys(args: {
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

function resolveTrackedTabCompletionState(args: {
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
    const hasNewerDoneStamp =
      doneStamp !== undefined &&
      entry.acknowledgedDoneAt !== undefined &&
      doneStamp > entry.acknowledgedDoneAt
    const hasUnacknowledgedCompletion = entry.unread || entry.sawInTurn || hasNewerDoneStamp
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

function resolveRawSessionTabDotState(
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

function resolveTabDoneStamp(tab: {
  type?: MobileSessionTab['type']
  agentStatus?: (AgentStatusEntry & { restoredUnconfirmed?: boolean }) | null
  chatStatus?: Extract<MobileSessionTab, { type: 'agent-session' }>['chatStatus'] | null
}): number | undefined {
  if (tab.type === 'terminal' && tab.agentStatus) {
    return tab.agentStatus.updatedAt
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

function findSnapshotCatalogAgentRow(
  worktrees: readonly unknown[] | undefined,
  worktreeId: string | undefined,
  paneKey: string | null
): Record<string, unknown> | null {
  if (!worktrees || !worktreeId || !paneKey) {
    return null
  }
  for (const wt of worktrees) {
    if (!isRecord(wt)) {
      continue
    }
    const wtId =
      typeof wt.worktreeId === 'string'
        ? wt.worktreeId
        : typeof wt.id === 'string'
          ? wt.id
          : null
    if (wtId !== worktreeId || !Array.isArray(wt.agents)) {
      continue
    }
    for (const row of wt.agents) {
      if (isRecord(row) && row.paneKey === paneKey) {
        return row
      }
    }
  }
  return null
}

function resolveSnapshotSessionTabDotState(
  item: Record<string, unknown>,
  now = Date.now(),
  options?: { worktreeId?: string; worktrees?: readonly unknown[] }
): { agentState: AgentDotState | null; doneStamp?: number } {
  let raw =
    item.type === 'terminal'
      ? item.agentStatus
      : item.type === 'agent-session'
        ? item.chatStatus
        : null
  if (item.type === 'terminal' && options?.worktrees && options.worktreeId) {
    const rawObj = isRecord(raw) ? raw : null
    const promptEmpty = !rawObj || rawObj.prompt === ''
    if (promptEmpty) {
      const paneKey =
        (rawObj && typeof rawObj.paneKey === 'string' && rawObj.paneKey) ||
        (typeof item.parentTabId === 'string' && typeof item.leafId === 'string'
          ? `${item.parentTabId}:${item.leafId}`
          : null)
      const catalogRow = findSnapshotCatalogAgentRow(
        options.worktrees,
        options.worktreeId,
        paneKey
      )
      if (catalogRow && typeof catalogRow.updatedAt === 'number') {
        const rawUpdatedAt =
          rawObj && typeof rawObj.updatedAt === 'number' ? rawObj.updatedAt : -Infinity
        const rawStateStartedAt =
          rawObj && typeof rawObj.stateStartedAt === 'number' ? rawObj.stateStartedAt : undefined
        const catalogStateStartedAt =
          typeof catalogRow.stateStartedAt === 'number' ? catalogRow.stateStartedAt : undefined
        const predatesStart =
          rawStateStartedAt !== undefined &&
          catalogRow.updatedAt < rawStateStartedAt &&
          (catalogStateStartedAt === undefined || catalogStateStartedAt < rawStateStartedAt)
        if (
          !predatesStart &&
          (catalogRow.updatedAt >= rawUpdatedAt ||
            (rawObj?.state === 'done' && catalogRow.state !== 'done'))
        ) {
          raw = catalogRow
        }
      }
    }
  }
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
    item.type === 'terminal' &&
    'restoredUnconfirmed' in raw &&
    raw.restoredUnconfirmed === true
  ) {
    return { agentState: 'idle' }
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
): {
  id: string
  terminal?: string | null
  agentState?: AgentDotState | null
  doneStamp?: number
}[] | null {
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
