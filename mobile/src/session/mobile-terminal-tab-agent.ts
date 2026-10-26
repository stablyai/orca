import { stripLeadingAgentTitleDecorationOrEmpty } from '../../../src/shared/agent-title-decoration'
import { resolveExplicitTerminalTitleAgentType } from '../../../src/shared/terminal-title-agent-type'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isBlankBrowserUrl } from '../browser/browser-url'
import type { MobileSessionTab } from './mobile-session-route-types'

type MobileTerminalTabAgentIdentity = {
  title: string
  agentStatus?: { agentType?: AgentStatusEntry['agentType'] | null } | null
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
  // Strip status glyphs when showing provider icons; glyph-only iOS titles otherwise leave stray colored boxes.
  if (resolveMobileTerminalTabAgentId(tab, hostAgentIdentity)) {
    return stripLeadingAgentTitleDecorationOrEmpty(tab.title) || 'Terminal'
  }
  return tab.title || 'Terminal'
}
