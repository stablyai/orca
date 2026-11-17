import type Database from '../../../sqlite/sync-database'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { AGENT_SESSION_TABS_RECORDED } from '../../../runtime/agent-session/records/agent-session-record-rows'

/** The original's tabs (null when it never recorded them) and this file's tabs, read once per pass. */
export type AdoptedTabs = {
  savedTabs: Map<string, string> | null
  tabbed: Set<string>
  takenTabs: Set<string>
  nextPosition: number
  tabsRecorded: boolean
}

/**
 * Only a chat this file already held, closed here and in the older build, stays closed: its tab
 * and history row are as before the pass. A chat new here, a copy (which shares its original's
 * history row) and a chat with no conversation (before a reply, after /clear) open, as nothing
 * else is sure to reach them.
 */
export function showAdoptedChat(
  db: Database.Database,
  tabs: AdoptedTabs,
  id: string,
  as: string,
  record: string,
  here: boolean
): void {
  const saved = tabs.savedTabs?.get(id)
  if (here && tabs.savedTabs !== null && saved === undefined && hasHistoryRow(record)) {
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

/** Chat history lists a local chat by the head of its provider chain. */
function hasHistoryRow(record: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(record)
  } catch {
    return false
  }
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    'providerHandleChain' in parsed &&
    Array.isArray(parsed.providerHandleChain) &&
    parsed.providerHandleChain.length > 0 &&
    'location' in parsed &&
    typeof parsed.location === 'object' &&
    parsed.location !== null &&
    'executionHostId' in parsed.location &&
    parsed.location.executionHostId === LOCAL_EXECUTION_HOST_ID
  )
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
