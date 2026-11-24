import type {
  MobileSessionTabEntry,
  MobileSessionTabGroup,
  MobileSessionTabRow,
  MobileSessionTabSummary
} from './mobile-session-tab-rows'
import { isMobileTerminalTabRunningAgent } from './mobile-terminal-tab-agent'

type Entry = MobileSessionTabEntry<MobileSessionTabRow>

const DAY_MS = 24 * 60 * 60 * 1000
/** Fewer tabs than this all fit on a screen or two, so nothing folds away. */
const OLDER_FOLD_MIN_TABS = 10

const settled = (row: MobileSessionTabRow) => row.dotState === 'done' || row.dotState === 'idle'

// Still the agent's tab, not a shell it returned to (which keeps the agent's finished status).
const isAgentTab = (tab: MobileSessionTabSummary['tab']) =>
  tab.type === 'agent-session' || (tab.type === 'terminal' && isMobileTerminalTabRunningAgent(tab))

export const mobileSessionTabEntryGroup = (entry: Entry): MobileSessionTabGroup =>
  entry.kind === 'tab' ? entry.tab.group : entry.group

/**
 * Where each entry sits while the sheet is open: its section, and whether it folds into Older (a
 * done or idle agent nobody has touched for a day, once there are enough tabs to need folding).
 * The open tab never folds, so the switcher always shows where you are.
 */
export function placeMobileSessionTabEntries(
  entries: readonly Entry[],
  now: number,
  activeTabId: string | null
): ReadonlyMap<string, { group: MobileSessionTabGroup; older: boolean }> {
  const folds = entries.length >= OLDER_FOLD_MIN_TABS
  return new Map(
    entries.map((entry) => {
      const group = mobileSessionTabEntryGroup(entry)
      const older =
        folds &&
        group === 'other' &&
        entry.kind === 'tab' &&
        entry.tab.tab.id !== activeTabId &&
        !entry.tab.unread &&
        isAgentTab(entry.tab.tab) &&
        settled(entry.tab) &&
        entry.tab.timeAt !== null &&
        now - entry.tab.timeAt >= DAY_MS
      return [entry.key, { group, older }]
    })
  )
}

/**
 * Agent tabs that finished and were read: done (an idle state can be a working one gone quiet),
 * still the agent's tab rather than a shell it returned to, not pinned, and not the open tab.
 */
export function finishedMobileSessionTabs<T extends MobileSessionTabSummary>(
  rows: readonly T[],
  activeTabId: string | null
): T[] {
  return rows.filter(
    ({ tab, dotState, unread }) =>
      dotState === 'done' &&
      !unread &&
      tab.id !== activeTabId &&
      tab.type !== 'markdown' &&
      tab.type !== 'file' &&
      tab.type !== 'browser' &&
      tab.isPinned !== true &&
      isAgentTab(tab)
  )
}
