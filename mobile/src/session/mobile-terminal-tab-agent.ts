import { stripLeadingAgentTitleDecorationOrEmpty } from '../../../src/shared/agent-title-decoration'
import { resolveExplicitTerminalTitleAgentType } from '../../../src/shared/terminal-title-agent-type'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { TuiAgent } from '../../../src/shared/types'
import { isBlankBrowserUrl } from '../browser/browser-url'
import type { MobileSessionTab } from '../../app/h/[hostId]/session/mobile-session-route-types'
import { t } from '@/i18n/mobile-i18n'

// Why: tab identity + title cleaning uses the same shared glyph/label maps as
// desktop, so the two platforms do not drift on which titles identify agents.

/**
 * Resolve which coding agent a mobile terminal tab is running, for its tab
 * icon. Hook-reported `agentType` is the authoritative signal; the OSC title is
 * the fallback for sessions without hook status or a host launch identity.
 * Returns null when no agent is identified (plain shell / unknown), so the tab
 * keeps its text-only label.
 */
export function resolveMobileTerminalTabAgentId(tab: {
  title: string
  agentStatus?: AgentStatusEntry | null
  launchAgent?: TuiAgent
}): string | null {
  const hookAgentType = tab.agentStatus?.agentType?.trim()
  if (hookAgentType && hookAgentType !== 'unknown') {
    return hookAgentType
  }
  if (tab.launchAgent) {
    return tab.launchAgent
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
      return t('m.tgyhT8Q')
    }
    return t('m.YHLAtbk')
  }
  if (tab.type === 'markdown') {
    return tab.title || t('m.oS6AL4Y')
  }
  if (tab.type === 'file') {
    return tab.title || t('m.nMoq2GI')
  }
  // Why: strip the leading agent status glyph (✳ etc.) once the tab shows the
  // provider icon. Mobile falls back for glyph-only titles because iOS can
  // render the bare status glyph as a stray colored box beside the icon.
  if (resolveMobileTerminalTabAgentId(tab)) {
    return stripLeadingAgentTitleDecorationOrEmpty(tab.title) || t('m.ubcC1kU')
  }
  return tab.title || t('m.ubcC1kU')
}
