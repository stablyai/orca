import { stripLeadingAgentTitleDecoration } from '../../../src/shared/agent-title-decoration'
import { redactKagiSessionToken } from '../../../src/shared/browser-url'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/tui-agent-display-names'
import { isTuiAgent } from '../../../src/shared/tui-agent-config'
import { isBlankBrowserUrl } from '../browser/browser-url'
import { translate } from '../i18n/mobile-i18n'
import { agentDotState, type AgentDotState } from '../worktree/agent-row-display'
import {
  getMobileSessionTabTitle,
  resolveMobileTerminalTabAgentId
} from './mobile-terminal-tab-agent'
import type { MobileSessionTab } from './mobile-session-route-types'

export function mobileSessionTabCardContent(
  tab: MobileSessionTab,
  hostAgentIdentity: string | undefined,
  now: number
) {
  const agentId =
    tab.type === 'agent-session'
      ? tab.agent
      : tab.type === 'terminal'
        ? resolveMobileTerminalTabAgentId(tab, hostAgentIdentity)
        : null
  const status =
    tab.type === 'agent-session'
      ? tab.chatStatus
      : tab.type === 'terminal' && !tab.agentStatus?.restoredUnconfirmed
        ? tab.agentStatus
        : null
  const dot = status ? agentDotState(status, now) : null
  const state: AgentDotState | null = dot === 'idle' || dot === 'unconfirmed' ? null : dot
  if (tab.type === 'file' || tab.type === 'markdown') {
    return {
      title: tab.relativePath.split(/[\\/]/).at(-1) || tab.title,
      detail: tab.relativePath,
      programName: translate('session.tabCard.editor', 'Editor'),
      agentId: null,
      state: null,
      kind: tab.type
    }
  }
  if (tab.type === 'browser') {
    const blank = isBlankBrowserUrl(tab.url)
    const url = redactKagiSessionToken(tab.url)
    let label = url
    try {
      const parsed = new URL(url)
      label = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`
    } catch {
      /* Non-URL labels remain readable. */
    }
    return {
      title:
        tab.title && tab.title !== tab.url && !isBlankBrowserUrl(tab.title)
          ? tab.title
          : blank
            ? translate('session.terminalTabAgent.newBrowser', 'New Browser')
            : label,
      detail: null,
      programName: blank ? translate('session.terminalTabAgent.browser', 'Browser') : label,
      agentId: null,
      state: null,
      kind: tab.type
    }
  }
  const title = agentId ? stripLeadingAgentTitleDecoration(tab.title) : tab.title
  return {
    title: title === '' ? getMobileSessionTabTitle(tab, hostAgentIdentity) : title,
    detail: null,
    programName: agentId
      ? isTuiAgent(agentId)
        ? TUI_AGENT_DISPLAY_NAMES[agentId]
        : agentId
      : translate('session.terminalTabAgent.terminal', 'Terminal'),
    agentId,
    state,
    kind: tab.type
  }
}
