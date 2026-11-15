import type { AgentReadEntry } from '../../../../../shared/agent-conversations/agent-conversation-contracts'
import { agentChatEntryOf } from '../../../../../shared/agent-conversations/agent-chat-entries'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryRequest
} from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import { readAgentSessionHistory } from './agent-session-history-page'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  oversizedHistoryItem
} from './agent-session-history-page-bounds'

export type AgentReadJournalPage = { entries: AgentReadEntry[]; limited: boolean }

/** One `orca agent read` page from a chat's journal: its newest entries in the current context,
 *  walked back over the chat's own bounded history pages, so it never renders the timeline. A
 *  page stops at `limit` entries or the history page byte budget, whichever comes first; entries
 *  keep the history wire form (visibly shortened, or the too-large marker when even that can't
 *  fit). `waiting`: the live answer for a pending prompt. */
export async function readAgentJournalPage(
  journal: SqlAgentSessionJournal,
  request: { sessionId: string; limit: number },
  waiting: (itemId: string) => boolean
): Promise<AgentReadJournalPage> {
  const page = new PageBudget(request.limit)
  // The chat shows only what follows the latest `/clear`; its divider opens the read.
  const floor = (await journal.reads.contextFloor())?.sequence ?? 0
  const newestFirst: AgentReadEntry[] = []
  let history: AgentSessionHistoryRequest = {
    sessionId: request.sessionId,
    direction: 'tail',
    limit: AGENT_SESSION_HISTORY_MAX_LIMIT
  }
  for (;;) {
    const read = await readAgentSessionHistory(journal, history)
    if (!read.ok && history.direction === 'before') {
      // The history was replaced under the walk; the entries so far are all this page can vouch for.
      return { entries: newestFirst.toReversed(), limited: true }
    }
    const { items, hasOlder, window } = read.page
    for (const item of items.toReversed()) {
      if (item.sequence < floor) {
        return { entries: newestFirst.toReversed(), limited: false }
      }
      const entry = entryOf(item, waiting)
      if (!entry) {
        continue
      }
      if (!page.admit(entry)) {
        return { entries: newestFirst.toReversed(), limited: true }
      }
      newestFirst.push(entry)
    }
    if (!hasOlder || !window.oldest) {
      return { entries: newestFirst.toReversed(), limited: false }
    }
    history = { ...history, direction: 'before', cursor: window.oldest }
  }
}

/** The entry a history item reads as. One no page could carry reads as the history's own
 *  too-large marker, said by Orca rather than the agent. */
function entryOf(
  item: AgentJournalRenderItem,
  waiting: (itemId: string) => boolean
): AgentReadEntry | null {
  const entry = agentChatEntryOf(item, waiting)
  if (!entry) {
    return null
  }
  const shown: AgentReadEntry = item.shortened ? { ...entry, shortened: true } : entry
  if (entryBytes(shown) <= HISTORY_PAGE_CONTENT_BUDGET_BYTES) {
    return shown
  }
  const marker = oversizedHistoryItem(item).body
  return {
    kind: 'message',
    role: 'system',
    text: marker.kind === 'status' ? String(marker.text) : ''
  }
}

/** An entry's serialized size, with its separator in the page's entries array. */
const entryBytes = (entry: AgentReadEntry) => Buffer.byteLength(JSON.stringify(entry)) + 1

/** `limit` entries within the history page's byte budget. */
class PageBudget {
  private count = 0
  private bytes = 0

  constructor(private readonly limit: number) {}

  admit(entry: AgentReadEntry): boolean {
    const size = entryBytes(entry)
    if (this.count >= this.limit || this.bytes + size > HISTORY_PAGE_CONTENT_BUDGET_BYTES) {
      return false
    }
    this.count++
    this.bytes += size
    return true
  }
}
