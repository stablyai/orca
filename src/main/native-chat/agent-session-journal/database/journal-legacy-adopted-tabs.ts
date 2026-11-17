import type Database from '../../../sqlite/sync-database'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { AGENT_SESSION_TABS_RECORDED } from '../../../runtime/agent-session/records/agent-session-record-rows'

/** The original's tabs and this file's tabs, read once per pass. */
export type AdoptedTabs = {
  savedTabs: Map<string, string>
  tabbed: Set<string>
  takenTabs: Set<string>
  nextPosition: number
  tabsRecorded: boolean
}

/**
 * A chat joining as itself with a provider conversation keeps its own history row, so it opens only
 * if the older build had it open. A copy shares its original's history row, and a chat with no
 * conversation (before a reply, after /clear) has none, so only a tab reaches them.
 */
export function showAdoptedChat(
  db: Database.Database,
  tabs: AdoptedTabs,
  id: string,
  as: string,
  record: string
): void {
  const saved = tabs.savedTabs.get(id)
  if (as === id && saved === undefined && hasHistoryRow(record)) {
    return
  }
  if (!tabs.tabsRecorded) {
    recordTabIndex(db, tabs)
  }
  addTab(
    db,
    tabs,
    as,
    as === id && saved !== undefined && !tabs.takenTabs.has(saved)
      ? saved
      : structuredAgentSessionTabId(as)
  )
}

/** Chat history lists a chat by the head of its provider chain. */
function hasHistoryRow(record: string): boolean {
  try {
    const chain = (JSON.parse(record) as { providerHandleChain?: unknown }).providerHandleChain
    return Array.isArray(chain) && chain.length > 0
  } catch {
    return false
  }
}

/**
 * A file that never recorded its tab index shows chats by the ids its clients pass in, which a
 * kept chat can't be among. Recording the index with every chat here shown keeps what was shown.
 */
function recordTabIndex(db: Database.Database, tabs: AdoptedTabs): void {
  for (const { session_id: id } of db
    .prepare('SELECT session_id FROM agent_session_records')
    .all()) {
    addTab(db, tabs, String(id), structuredAgentSessionTabId(String(id)))
  }
  db.prepare('INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)').run(
    AGENT_SESSION_TABS_RECORDED,
    '1'
  )
  tabs.tabsRecorded = true
}

function addTab(db: Database.Database, tabs: AdoptedTabs, sessionId: string, tab: string): void {
  if (tabs.tabbed.has(sessionId) || tabs.takenTabs.has(tab)) {
    return
  }
  db.prepare('INSERT INTO agent_session_tabs(tab_id,session_id,position) VALUES(?,?,?)').run(
    tab,
    sessionId,
    tabs.nextPosition
  )
  tabs.nextPosition += 1
  tabs.tabbed.add(sessionId)
  tabs.takenTabs.add(tab)
}
