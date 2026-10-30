import { stripLeadingAgentTitleDecorationOrEmpty } from '../../../src/shared/agent-title-decoration'
import { isClaudeManagementTitle } from '../../../src/shared/agent-title-core'
import { isShellProcess } from '../../../src/shared/shell-process-detection'
import { agentTypeToIconAgent } from '../../../src/shared/agent-type-icon-agent'
import { resolveTabAgentFromSignalSnapshot } from '../../../src/shared/tab-agent-from-signals'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isBlankBrowserUrl } from '../browser/browser-url'
import { translate } from '../i18n/mobile-i18n'
import { agentDotState, type AgentDotState } from '../worktree/agent-row-display'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  clearCatalogWorktreesForTabStatusForTests,
  reconcileTerminalAgentStatusWithCatalog,
  setCatalogWorktreesForTabStatus,
  subscribeCatalogWorktreesForTabStatus
} from './session-tab-catalog-agent-status'

export { setCatalogWorktreesForTabStatus, subscribeCatalogWorktreesForTabStatus }

export {
  buildRecentSessionCardFromTab,
  recentCardSnapshotTabs,
  resolveLiveTabDotState,
  syncRecentCardWithLiveTab,
  type LiveRecentCardTab,
  type RecentSessionCardSnapshot
} from './recent-session-card-snapshot'

export type MobileTerminalTabAgentIdentity = {
  title: string
  agentStatus?: {
    agentType?: AgentStatusEntry['agentType'] | null
    state?: AgentStatusEntry['state']
  } | null
  launchAgent?: TuiAgent | null
}

export function getMobileTerminalTabHostAgentIdentity(
  tab: MobileSessionTab,
  terminals: readonly { handle: string; agentIdentity?: string }[]
): string | undefined {
  if (tab.type !== 'terminal' || !tab.terminal) {
    return undefined
  }
  return terminals.find((terminal) => terminal.handle === tab.terminal)?.agentIdentity
}

// Cursor imports Claude hooks; older hosts still report them as claude, so the host identity corrects that.
function correctCursorImportedHookAgent(
  hookAgentType: string | null | undefined,
  hostAgentIdentity: string | null | undefined
): string | null | undefined {
  return hookAgentType === 'claude' && hostAgentIdentity === 'cursor' ? 'cursor' : hookAgentType
}

export function resolveMobileTerminalTabOwnedAgentId(
  tab: MobileTerminalTabAgentIdentity,
  hostAgentIdentity?: string | null
): string | null {
  const hookAgentType = tab.agentStatus?.agentType?.trim()
  if (hookAgentType && hookAgentType !== 'unknown') {
    return correctCursorImportedHookAgent(hookAgentType, hostAgentIdentity) ?? null
  }
  if (tab.launchAgent) {
    return tab.launchAgent
  }
  return null
}

// An agent's tab stays an agent tab until the agent reports done and the title is a shell again. Launch hints count before status arrives.
export function isMobileTerminalTabRunningAgent(tab: MobileTerminalTabAgentIdentity): boolean {
  if (
    tab.agentStatus?.state === 'done' &&
    (isShellProcess(tab.title) || isClaudeManagementTitle(tab.title))
  ) {
    return false
  }
  return resolveMobileTerminalTabOwnedAgentId(tab) !== null
}

export function listMobileTerminalAgentHandles(tabs: readonly MobileSessionTab[]): string[] {
  return tabs.flatMap((tab) =>
    tab.type === 'terminal' && tab.terminal && isMobileTerminalTabRunningAgent(tab)
      ? [tab.terminal]
      : []
  )
}

// Phones get no process, sleeping-session or sibling signals; host Cursor identity stands in for an unowned pane's process, since terminal.list can keep it after the pane is reused.
export function resolveMobileTerminalTabAgentId(
  tab: MobileTerminalTabAgentIdentity,
  hostAgentIdentity?: string | null
): string | null {
  const status = tab.agentStatus
  const hookAgent = agentTypeToIconAgent(
    correctCursorImportedHookAgent(status?.agentType, hostAgentIdentity)
  )
  return resolveTabAgentFromSignalSnapshot({
    title: tab.title,
    hookAgent: status?.state === 'done' ? null : hookAgent,
    focusedCompletedHookAgent: status?.state === 'done' ? hookAgent : null,
    processAgent:
      hostAgentIdentity === 'cursor' && !resolveMobileTerminalTabOwnedAgentId(tab)
        ? 'cursor'
        : null,
    launchAgent: tab.launchAgent ?? undefined
  })
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
      return translate('session.terminalTabAgent.newBrowser', 'New Browser')
    }
    return translate('session.terminalTabAgent.browser', 'Browser')
  }
  if (tab.type === 'markdown') {
    return tab.title || translate('session.terminalTabAgent.markdown', 'Markdown')
  }
  if (tab.type === 'file') {
    return tab.title || translate('session.terminalTabAgent.file', 'File')
  }
  if (tab.type === 'agent-session') {
    return tab.title || translate('session.terminalTabAgent.chat', 'Chat')
  }
  // Strip status glyphs when showing provider icons; glyph-only iOS titles otherwise leave stray colored boxes.
  if (resolveMobileTerminalTabAgentId(tab, hostAgentIdentity)) {
    return (
      stripLeadingAgentTitleDecorationOrEmpty(tab.title) ||
      translate('session.terminalTabAgent.terminal', 'Terminal')
    )
  }
  return tab.title || translate('session.terminalTabAgent.terminal', 'Terminal')
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
  clearCatalogWorktreesForTabStatusForTests()
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
    id?: string
    parentTabId?: string | null
    leafId?: string | null
    type?: MobileSessionTab['type']
    agentStatus?: (AgentStatusEntry & { restoredUnconfirmed?: boolean }) | null
    chatStatus?: Extract<MobileSessionTab, { type: 'agent-session' }>['chatStatus'] | null
  },
  now = Date.now()
): AgentDotState | undefined {
  if (tab.type === 'terminal') {
    const status = reconcileTerminalAgentStatusWithCatalog(tab.agentStatus, {
      tabId: tab.id,
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

export function resolveTabDoneStamp(tab: {
  id?: string
  parentTabId?: string | null
  leafId?: string | null
  type?: MobileSessionTab['type']
  agentStatus?: (AgentStatusEntry & { restoredUnconfirmed?: boolean }) | null
  chatStatus?: Extract<MobileSessionTab, { type: 'agent-session' }>['chatStatus'] | null
}): number | undefined {
  if (tab.type === 'terminal') {
    const status = reconcileTerminalAgentStatusWithCatalog(tab.agentStatus, {
      tabId: tab.id,
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
  tab: {
    id?: string
    parentTabId?: string | null
    leafId?: string | null
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
