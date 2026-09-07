import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/tui-agent-display-names'
import type { MobileSessionTab, MobileSessionTabType } from './mobile-session-route-types'
import {
  getMobileSessionTabTitle,
  resolveMobileTerminalTabAgentId
} from './mobile-terminal-tab-agent'

/**
 * The only session-tab fields the tab strip draws. Everything else the live tab carries (unsent
 * launch drafts, absolute file paths, browser URLs, agent session ids) stays on the wire.
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

/**
 * Every tab type the strip knows how to draw. A stored entry naming anything else is dropped
 * rather than trusted, so a type added later fails closed: its rows go missing from the preview
 * instead of carrying an unreviewed title into storage.
 */
const drawableTabTypes = new Set<string>([
  'terminal',
  'markdown',
  'file',
  'browser',
  'agent-session'
] satisfies readonly MobileSessionTabType[])

export function isDrawableTabStripType(type: string): type is MobileSessionTabType {
  return drawableTabTypes.has(type)
}

const agentDisplayNames: Readonly<Record<string, string>> = TUI_AGENT_DISPLAY_NAMES

/**
 * The title a strip entry may be written to disk under.
 *
 * A terminal's title is whatever the shell last set, which is routinely the command line —
 * `psql postgres://user:password@host/db`, `curl -H "Authorization: Bearer ..."`. None of that
 * belongs in plaintext storage, and a browser tab's page title is no better. Both collapse to a
 * fixed label, so what survives is the shape of the strip, not its contents. A resolved agent
 * still names itself, because that lookup is a closed enum: an unrecognised id yields the
 * generic label rather than passing text through.
 */
export function getPersistableTabStripTitle(
  entry: Pick<MobileSessionTabStripEntry, 'type' | 'title' | 'agentId'>
): string {
  if (entry.type === 'terminal') {
    const agentLabel = entry.agentId === null ? undefined : agentDisplayNames[entry.agentId]
    return agentLabel ?? 'Terminal'
  }
  if (entry.type === 'browser') {
    return 'Browser'
  }
  return entry.title
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
