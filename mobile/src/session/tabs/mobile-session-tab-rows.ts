import { agentListPreview } from '../../agents/agent-list-row-text'
import { agentStatusGroup } from '../../agents/agent-list-rows'
import { AGENT_LIST_STATUS_RANK } from '../../../../src/shared/agent-status/presentation/agent-list-status'
import { translate } from '../../i18n/mobile-i18n'
import {
  getMobileSessionTabTitle,
  getMobileTerminalTabHostAgentIdentity,
  resolveMobileTerminalTabAgentId
} from './mobile-terminal-tab-agent'
import {
  agentDotState,
  agentRowTimeAt,
  agentStateLabel,
  type AgentDotState
} from '../../worktree/agent-lineage/agent-row-display'
import type { MobileSessionTab } from './mobile-session-tabs'

export type MobileSessionTabGroup = 'needs-you' | 'working' | 'other'

/** What the tab bar draws for every tab; cheap enough to rebuild on each tab snapshot and clock tick. */
export type MobileSessionTabSummary = {
  tab: MobileSessionTab
  title: string
  /** The agent whose icon marks the tab; null draws the tab kind's icon. */
  agentId: string | null
  dotState: AgentDotState | undefined
  group: MobileSessionTabGroup
  /** The desktop Agents list holds this tab's agent unread; hosts with no verdict never set it. */
  unread: boolean
}

/** A row of the all-tabs sheet: the summary plus what only the open sheet shows. */
export type MobileSessionTabRow = MobileSessionTabSummary & {
  /** The agent's state, drawn in its colour before the content; empty with no live state. */
  stateWord: string
  /** What the tab is doing or showing; empty when the title already says it. */
  content: string
  timeAt: number | null
}

/** One desktop tab in the all-tabs sheet: a lone tab, or a split whose panes the phone lists one by one. */
export type MobileSessionTabEntry<T extends MobileSessionTabSummary> =
  | { kind: 'tab'; key: string; tab: T }
  | {
      kind: 'split'
      key: string
      panes: T[]
      /** The most urgent pane's state and section. */
      dotState: AgentDotState | undefined
      group: MobileSessionTabGroup
      unread: boolean
    }

/** A chat tab the host marked as a fork; its title is drawn after the fork mark. */
export function isForkedChatTab(tab: MobileSessionTab): boolean {
  return tab.type === 'agent-session' && tab.forked === true
}

export function mobileSessionTabDotState(
  tab: MobileSessionTab,
  now: number
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

function tabGroup(state: AgentDotState | undefined): MobileSessionTabGroup {
  if (!state) {
    return 'other'
  }
  const group = agentStatusGroup(state)
  return group === 'needs-you' || group === 'working' ? group : 'other'
}

function tabContent(
  tab: MobileSessionTab,
  title: string,
  dotState: AgentDotState | undefined
): string {
  switch (tab.type) {
    case 'terminal': {
      const status = tab.agentStatus
      if (!status || !dotState) {
        return ''
      }
      return agentListPreview(status, agentStatusGroup(dotState), title)
    }
    case 'browser':
      return tab.url === title ? '' : tab.url
    case 'markdown':
    case 'file':
      return tab.relativePath === title ? '' : tab.relativePath
    case 'agent-session':
      return ''
  }
}

export function mobileSessionTabKindLabel(tab: MobileSessionTab): string {
  switch (tab.type) {
    case 'browser':
      return translate('session.tabRows.browser', 'Browser')
    case 'markdown':
      return translate('session.tabRows.markdown', 'Markdown note')
    case 'file':
      return translate('session.tabRows.file', 'File')
    case 'agent-session':
      return translate('session.tabRows.chat', 'Chat')
    case 'terminal':
      return translate('session.tabRows.terminal', 'Terminal')
  }
}

type HostTerminals = readonly { handle: string; agentIdentity?: string }[]

function tabAgentId(tab: MobileSessionTab, hostAgentIdentity: string | undefined): string | null {
  return tab.type === 'agent-session'
    ? tab.agent
    : tab.type === 'terminal'
      ? resolveMobileTerminalTabAgentId(tab, hostAgentIdentity)
      : null
}

/** The agent whose icon marks the tab; null draws the tab kind's icon. */
export function mobileSessionTabAgentId(
  tab: MobileSessionTab,
  terminals: HostTerminals
): string | null {
  return tabAgentId(tab, getMobileTerminalTabHostAgentIdentity(tab, terminals))
}

export function buildMobileSessionTabSummary(
  tab: MobileSessionTab,
  terminals: HostTerminals,
  now: number
): MobileSessionTabSummary {
  const hostAgentIdentity = getMobileTerminalTabHostAgentIdentity(tab, terminals)
  const dotState = mobileSessionTabDotState(tab, now)
  return {
    tab,
    title: getMobileSessionTabTitle(tab, hostAgentIdentity),
    agentId: tabAgentId(tab, hostAgentIdentity),
    dotState,
    group: tabGroup(dotState),
    unread: (tab.type === 'terminal' || tab.type === 'agent-session') && tab.unread === true
  }
}

// Why: the preview scans each agent's last message, so only the open sheet pays for it (STA-15103).
export function buildMobileSessionTabRow(summary: MobileSessionTabSummary): MobileSessionTabRow {
  const { tab, title, dotState } = summary
  const stateWord = dotState && dotState !== 'idle' ? agentStateLabel(dotState) : ''
  const content = tabContent(tab, title, dotState)
  const timeAt =
    tab.type === 'terminal' && tab.agentStatus && !tab.agentStatus.restoredUnconfirmed
      ? agentRowTimeAt(tab.agentStatus)
      : tab.type === 'agent-session' && tab.chatStatus
        ? tab.chatStatus.updatedAt
        : null
  return { ...summary, stateWord, content, timeAt }
}

// The phone gets one tab per split pane; panes of one desktop tab share its id as parentTabId.
function desktopTabKey(tab: MobileSessionTab): string {
  return tab.type === 'terminal' ? (tab.parentTabId ?? tab.id) : tab.id
}

/** How many tabs the desktop shows: a split counts once, however many panes it has. */
export function countMobileSessionDesktopTabs(tabs: readonly { tab: MobileSessionTab }[]): number {
  return new Set(tabs.map((row) => desktopTabKey(row.tab))).size
}

function mostUrgent(states: readonly (AgentDotState | undefined)[]): AgentDotState | undefined {
  return states.reduce<AgentDotState | undefined>(
    (best, state) =>
      state && (!best || AGENT_LIST_STATUS_RANK[state] < AGENT_LIST_STATUS_RANK[best])
        ? state
        : best,
    undefined
  )
}

/** Folds each split's panes into one entry at its first pane's place, in tab order. */
export function groupMobileSessionSplitTabs<T extends MobileSessionTabSummary>(
  tabs: readonly T[]
): MobileSessionTabEntry<T>[] {
  const panesByKey = new Map<string, T[]>()
  for (const row of tabs) {
    const key = desktopTabKey(row.tab)
    panesByKey.set(key, [...(panesByKey.get(key) ?? []), row])
  }
  const entries: MobileSessionTabEntry<T>[] = []
  for (const [key, panes] of panesByKey) {
    if (panes.length === 1) {
      entries.push({ kind: 'tab', key: panes[0].tab.id, tab: panes[0] })
      continue
    }
    const dotState = mostUrgent(panes.map((pane) => pane.dotState))
    entries.push({
      kind: 'split',
      key,
      panes,
      dotState,
      group: tabGroup(dotState),
      unread: panes.some((pane) => pane.unread)
    })
  }
  return entries
}
