import type { AgentReadEntry } from '../../../../../shared/agent-conversations/agent-conversation-contracts'
import { agentChatEntryOf } from '../../../../../shared/agent-conversations/agent-chat-entries'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionLatestTurn
} from '../../../../../shared/agent-session/agent-session-wire'
import { isAgentSessionContextClear } from '../../../../../shared/agent-session/agent-session-context-clear'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentStatusState } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { readAgentJournalTurnOutcome } from '../../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import { readAgentSessionHistoryFrame } from './agent-session-history-page'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  oversizedHistoryItem
} from './agent-session-history-page-bounds'

export type AgentReadJournalPage = {
  entries: AgentReadEntry[]
  limited: boolean
  state?: AgentStatusState
}

/** One bounded root-only history window, from one snapshot. Stop at its latest `/clear`
 *  divider; sparse non-entry rows spend the window too, so they cannot cause an unbounded walk. */
export async function readAgentJournalPage(
  journal: SqlAgentSessionJournal,
  request: { sessionId: string; limit: number },
  waiting: (itemId: string) => boolean
): Promise<AgentReadJournalPage> {
  const frame = await readAgentSessionHistoryFrame(
    journal,
    {
      sessionId: request.sessionId,
      direction: 'tail',
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    },
    { scope: 'own-agent', acceptedUnopened: true }
  )
  const { page } = frame.result
  const shown = pageEntries(page.items, page.hasOlder, request.limit, waiting)
  const state = journalTurnState(page.latestTurn, frame.acceptedUnopened === true, shown)
  return { entries: shown.entries, limited: shown.limited, ...(state ? { state } : {}) }
}

type ShownEntries = { entries: AgentReadEntry[]; limited: boolean; newest?: AgentJournalRenderItem }

function pageEntries(
  items: readonly AgentJournalRenderItem[],
  hasOlder: boolean,
  limit: number,
  waiting: (itemId: string) => boolean
): ShownEntries {
  const page = new PageBudget(limit)
  const newestFirst: AgentReadEntry[] = []
  let newest: AgentJournalRenderItem | undefined
  let omitted = false
  const shown = (limited: boolean): ShownEntries => ({
    entries: newestFirst.toReversed(),
    limited,
    ...(newest ? { newest } : {})
  })
  for (const item of items.toReversed()) {
    const entry = entryOf(item, waiting)
    if (entry) {
      if (!page.admit(entry)) {
        return shown(true)
      }
      newestFirst.push(entry)
      newest ??= item
      omitted ||= entry.shortened === true
    }
    if (isAgentSessionContextClear(item.body)) {
      return shown(omitted)
    }
  }
  return shown(omitted || hasOlder)
}

/** The latest turn as this snapshot records it. `done` only for an explicitly successful turn
 *  whose own reply is the newest entry shown, so a newer prompt never inherits it; unknown
 *  otherwise (failed, interrupted, legacy, or its reply outside this page). */
function journalTurnState(
  latest: AgentSessionLatestTurn | null | undefined,
  acceptedUnopened: boolean,
  shown: ShownEntries
): AgentStatusState | undefined {
  if (shown.entries.some((entry) => 'pending' in entry && entry.pending)) {
    return 'waiting'
  }
  if (acceptedUnopened || latest?.turn.state === 'running') {
    return 'working'
  }
  const reply = shown.entries.at(-1)
  const scope = shown.newest?.turnScope
  return latest?.turn.state === 'completed' &&
    readAgentJournalTurnOutcome(latest.turn) === 'success' &&
    reply?.kind === 'message' &&
    reply.role === 'assistant' &&
    scope?.kind === 'turn' &&
    scope.turnItemId === latest.itemId
    ? 'done'
    : undefined
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
