import type { AgentReadEntry } from '../../../../../shared/agent-conversations/agent-conversation-contracts'
import { agentChatEntryOf } from '../../../../../shared/agent-conversations/agent-chat-entries'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../../../shared/agent-session/agent-session-wire'
import { isAgentSessionContextClear } from '../../../../../shared/agent-session/agent-session-context-clear'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import { readAgentSessionHistory } from './agent-session-history-page'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  oversizedHistoryItem
} from './agent-session-history-page-bounds'

export type AgentReadJournalPage = { entries: AgentReadEntry[]; limited: boolean }

/** One bounded root-only history window, from one snapshot. Stop at its latest `/clear`
 *  divider; sparse non-entry rows spend the window too, so they cannot cause an unbounded walk. */
export async function readAgentJournalPage(
  journal: SqlAgentSessionJournal,
  request: { sessionId: string; limit: number },
  waiting: (itemId: string) => boolean
): Promise<AgentReadJournalPage> {
  const page = new PageBudget(request.limit)
  const read = await readAgentSessionHistory(
    journal,
    {
      sessionId: request.sessionId,
      direction: 'tail',
      limit: Math.min(AGENT_SESSION_HISTORY_MAX_LIMIT, 2 * request.limit + 1)
    },
    { scope: 'own-agent' }
  )
  const newestFirst: AgentReadEntry[] = []
  let omitted = false
  for (const item of read.page.items.toReversed()) {
    const entry = entryOf(item, waiting)
    if (entry) {
      if (!page.admit(entry)) {
        return { entries: newestFirst.toReversed(), limited: true }
      }
      newestFirst.push(entry)
      omitted ||= entry.shortened === true
    }
    if (isAgentSessionContextClear(item.body)) {
      return { entries: newestFirst.toReversed(), limited: omitted }
    }
  }
  return { entries: newestFirst.toReversed(), limited: omitted || read.page.hasOlder }
}

/** The entry a history item reads as. One no page could carry reads as the history's own
 *  too-large marker, said by Orca rather than the agent. */
function entryOf(
  item: AgentJournalRenderItem,
  waiting: (itemId: string) => boolean
): AgentReadEntry | null {
  const entry: AgentReadEntry | null =
    item.body.kind === 'status' && item.body.presentation === 'history-item-too-large'
      ? { kind: 'message', role: 'system', text: String(item.body.text), shortened: true }
      : agentChatEntryOf(item, waiting)
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
    text: marker.kind === 'status' ? String(marker.text) : '',
    shortened: true
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
