import type { AgentReadEntry } from '../../../../../shared/agent-conversations/agent-conversation-contracts'
import { agentChatEntryOf } from '../../../../../shared/agent-conversations/agent-chat-entries'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { journalAgentReadIndex } from '../../../agent-session-journal/projection/journal-agent-read-index'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemForWire } from './agent-session-item-wire-form'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  oversizedHistoryItem
} from './agent-session-history-page-bounds'

export type AgentReadJournalPage = { entries: AgentReadEntry[]; limited: boolean }

/** One `orca agent read` page from a chat's journal: its newest entries in the current context,
 *  walked back over the journal's live agent-read entries, so work is bounded by the page. It
 *  never renders the timeline, builds a snapshot or scans for turns. Entries use the history wire
 *  form (visibly shortened when too large, or the history's too-large marker when even that can't
 *  fit a page), and a page stops at `limit` entries or the history page byte budget, whichever
 *  comes first. `waiting`: the live answer for a pending prompt. */
export function readAgentJournalPage(
  journal: AgentSessionJournal,
  request: { limit: number },
  waiting: (itemId: string) => boolean
): AgentReadJournalPage {
  const page = new PageBudget(request.limit)
  const newestFirst: AgentReadEntry[] = []
  let limited = false
  for (const item of journalAgentReadIndex(journal).newestFirst()) {
    const entry = entryOf(item, waiting)
    if (!entry) {
      continue
    }
    if (!page.admit(entry)) {
      limited = true
      break
    }
    newestFirst.push(entry)
  }
  return { entries: newestFirst.toReversed(), limited }
}

/** The entry an item reads as, from its history wire form. One no page could carry reads as the
 *  history's own too-large marker, said by Orca rather than the agent. */
function entryOf(
  item: AgentJournalRenderItem,
  waiting: (itemId: string) => boolean
): AgentReadEntry | null {
  const sent = agentJournalItemForWire(item)
  const entry = agentChatEntryOf(sent.item, waiting)
  if (!entry) {
    return null
  }
  const shown: AgentReadEntry = sent.item.shortened ? { ...entry, shortened: true } : entry
  if (
    sent.bytes <= HISTORY_PAGE_CONTENT_BUDGET_BYTES &&
    entryBytes(shown) <= HISTORY_PAGE_CONTENT_BUDGET_BYTES
  ) {
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
