import { stripLeadingAgentTitleDecorationOrEmpty } from '../../../src/shared/agent-title-decoration'
import { resolveExplicitTerminalTitleAgentType } from '../../../src/shared/terminal-title-agent-type'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isBlankBrowserUrl } from '../browser/browser-url'
import type { MobileSessionTab } from './mobile-session-route-types'

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

/** Agent identity Orca owns, excluding the display-only title fallback. */
export function resolveMobileTerminalTabOwnedAgentId(
  tab: MobileTerminalTabAgentIdentity
): string | null {
  const hookAgentType = tab.agentStatus?.agentType?.trim()
  if (hookAgentType && hookAgentType !== 'unknown') {
    return hookAgentType
  }
  if (tab.launchAgent) {
    return tab.launchAgent
  }
  return null
}

export function resolveMobileTerminalTabAgentId(
  tab: MobileTerminalTabAgentIdentity
): string | null {
  const ownedAgent = resolveMobileTerminalTabOwnedAgentId(tab)
  if (ownedAgent) {
    return ownedAgent
  }
  return resolveExplicitTerminalTitleAgentType(tab.title)
}

export function getMobileSessionTabTitle(tab: MobileSessionTab): string {
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
  // Why: strip the leading agent status glyph (✳ etc.) once the tab shows the
  // provider icon. Mobile falls back for glyph-only titles because iOS can
  // render the bare status glyph as a stray colored box beside the icon.
  if (resolveMobileTerminalTabAgentId(tab)) {
    return stripLeadingAgentTitleDecorationOrEmpty(tab.title) || 'Terminal'
  }
  return tab.title || 'Terminal'
}
