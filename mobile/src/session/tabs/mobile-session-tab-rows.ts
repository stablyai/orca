import { agentListPreview } from '../../agents/agent-list-row-text'
import { agentStatusGroup } from '../../agents/agent-list-rows'
import { translate } from '../../i18n/mobile-i18n'
import {
  getMobileSessionTabTitle,
  getMobileTerminalTabHostAgentIdentity,
  resolveMobileTerminalTabAgentId
} from '../../terminal/session/mobile-terminal-tab-agent'
import {
  agentDotState,
  agentRowTimeAt,
  agentStateLabel,
  type AgentDotState
} from '../../worktree/agent-row-display'
import type { MobileSessionTab } from './mobile-session-tabs'

export type MobileSessionTabGroup = 'needs-you' | 'working' | 'other'

export type MobileSessionTabRow = {
  tab: MobileSessionTab
  title: string
  /** The agent whose icon marks the tab; null draws the tab kind's icon. */
  agentId: string | null
  dotState: AgentDotState | undefined
  group: MobileSessionTabGroup
  /** The second line: the state, then what the tab is doing or showing. */
  detail: string
  timeAt: number | null
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

function tabKindLabel(tab: MobileSessionTab): string {
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

export function buildMobileSessionTabRow(
  tab: MobileSessionTab,
  terminals: readonly { handle: string; agentIdentity?: string }[],
  now: number
): MobileSessionTabRow {
  const hostAgentIdentity = getMobileTerminalTabHostAgentIdentity(tab, terminals)
  const title = getMobileSessionTabTitle(tab, hostAgentIdentity)
  const dotState = mobileSessionTabDotState(tab, now)
  const stateWord = dotState && dotState !== 'idle' ? agentStateLabel(dotState) : ''
  const content = tabContent(tab, title, dotState)
  const timeAt =
    tab.type === 'terminal' && tab.agentStatus && !tab.agentStatus.restoredUnconfirmed
      ? agentRowTimeAt(tab.agentStatus)
      : tab.type === 'agent-session' && tab.chatStatus
        ? tab.chatStatus.updatedAt
        : null
  return {
    tab,
    title,
    agentId:
      tab.type === 'agent-session'
        ? tab.agent
        : tab.type === 'terminal'
          ? resolveMobileTerminalTabAgentId(tab, hostAgentIdentity)
          : null,
    dotState,
    group: tabGroup(dotState),
    detail: [stateWord, content].filter(Boolean).join(' · ') || tabKindLabel(tab),
    timeAt
  }
}
