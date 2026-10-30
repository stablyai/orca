import { stripLeadingAgentTitleDecorationOrEmpty } from '../../../src/shared/agent-title-decoration'
import { agentTypeToIconAgent } from '../../../src/shared/agent-type-icon-agent'
import { resolveTabAgentFromSignalSnapshot } from '../../../src/shared/tab-agent-from-signals'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isBlankBrowserUrl } from '../browser/browser-url'
import { translate } from '../i18n/mobile-i18n'
import type { MobileSessionTab } from './mobile-session-route-types'

type MobileTerminalTabAgentIdentity = {
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
