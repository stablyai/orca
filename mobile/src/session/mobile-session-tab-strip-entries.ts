import type { MobileSessionTab, MobileSessionTabType } from './mobile-session-route-types'
import {
  getMobileSessionTabTitle,
  resolveMobileTerminalTabAgentId
} from './mobile-terminal-tab-agent'

/**
 * The only session-tab fields the tab strip draws — and therefore the only ones worth keeping
 * for a reconnect preview. Everything the live tab carries besides these (unsent launch drafts,
 * absolute file paths, browser URLs, agent session ids) stays on the wire and out of storage.
 */
export type MobileSessionTabStripEntry = {
  id: string
  type: MobileSessionTabType
  title: string
  agentId: string | null
}

export type MobileSessionTabStripPreview = {
  tabs: readonly MobileSessionTabStripEntry[]
  activeTabId: string | null
}

export type MobileSessionTabStripRow = {
  entry: MobileSessionTabStripEntry
  isActive: boolean
  /** null on a preview row: switching to that tab needs a live connection. */
  tab: MobileSessionTab | null
}

export function toMobileSessionTabStripEntry(tab: MobileSessionTab): MobileSessionTabStripEntry {
  return {
    id: tab.id,
    type: tab.type,
    title: getMobileSessionTabTitle(tab),
    agentId:
      tab.type === 'agent-session'
        ? tab.agent
        : tab.type === 'terminal'
          ? resolveMobileTerminalTabAgentId(tab)
          : null
  }
}

export function toMobileSessionTabStripPreview(
  tabs: readonly MobileSessionTab[],
  activeTabId: string | null
): MobileSessionTabStripPreview {
  return { tabs: tabs.map(toMobileSessionTabStripEntry), activeTabId }
}

/**
 * Rows for the header strip. Live tabs always win; the preview only fills a strip that has no
 * live rows yet, and its ids are the live ids, so the swap reuses the same React keys.
 */
export function getMobileSessionTabStripRows(args: {
  liveTabs: readonly MobileSessionTab[]
  activeSessionTabId: string | null
  preview: MobileSessionTabStripPreview | null
}): MobileSessionTabStripRow[] {
  const { liveTabs, activeSessionTabId, preview } = args
  if (liveTabs.length > 0 || !preview) {
    return liveTabs.map((tab) => ({
      entry: toMobileSessionTabStripEntry(tab),
      isActive: tab.id === activeSessionTabId,
      tab
    }))
  }
  return preview.tabs.map((entry) => ({
    entry,
    isActive: entry.id === preview.activeTabId,
    tab: null
  }))
}
