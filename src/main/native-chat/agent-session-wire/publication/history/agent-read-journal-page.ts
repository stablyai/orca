import type { AgentReadEntry } from '../../../../../shared/agent-conversations/agent-conversation-contracts'
import { agentChatEntryOf } from '../../../../../shared/agent-conversations/agent-chat-entries'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionLatestTurn
} from '../../../../../shared/agent-session/agent-session-wire'
import { isAgentSessionContextClear } from '../../../../../shared/agent-session/conversation-context/agent-session-context-clear'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentStatusState } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { readAgentJournalTurnOutcome } from '../../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import { readAgentSessionHistoryFrame } from './agent-session-history-page'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  oversizedHistoryItem
} from './agent-session-history-page-bounds'
import type { JournalAgentReadExtent } from '../../../agent-session-journal/journal-domain-agent-read'
import {
  decodeChatAgentReadCursor,
  encodeChatAgentReadCursor,
  staleAgentReadCursor
} from '../../../../runtime/agent-conversations/agent-read-cursor'

export type AgentReadJournalPage = {
  entries: AgentReadEntry[]
  limited: boolean
  /** Reads the next older page; null at the start of the running session's journal. */
  nextCursor: string | null
  /** The page ended at a `/clear`: the next older page is the earlier conversation, or with no
   *  cursor an earlier conversation exists that can't be read here. */
  clearedBefore?: true
  state?: AgentStatusState
}

export type AgentReadPageRequest = {
  orcaSessionId: string
  limit: number
  cursor?: string
  /** A legacy `/clear` replaced an earlier session with this one; its journal isn't read. */
  clearedFromEarlierSession?: boolean
}

/** One bounded root-only window from one snapshot; sparse non-entry rows spend it too, so a
 *  window of them is an empty page with a cursor, never an unbounded walk. */
export async function readAgentJournalPage(
  journal: SqlAgentSessionJournal,
  request: AgentReadPageRequest & { sessionId: string },
  waiting: (itemId: string) => boolean
): Promise<AgentReadJournalPage> {
  const { orcaSessionId, sessionId } = request
  const position =
    request.cursor === undefined ? null : decodeChatAgentReadCursor(request.cursor, orcaSessionId)
  if (position && position.sessionId !== sessionId) {
    throw staleAgentReadCursor(orcaSessionId)
  }
  const frame = await readAgentSessionHistoryFrame(
    journal,
    position
      ? {
          sessionId,
          direction: 'before',
          cursor: { epoch: position.epoch, sequence: position.anchor.sequence },
          limit: AGENT_SESSION_HISTORY_MAX_LIMIT
        }
      : { sessionId, direction: 'tail', limit: AGENT_SESSION_HISTORY_MAX_LIMIT },
    position
      ? {
          scope: 'own-agent',
          agentRead: {
            olderThan: position.anchor,
            since: { headSequence: position.headSequence, maxOrdinal: position.maxOrdinal }
          }
        }
      : { scope: 'own-agent', acceptedUnopened: true, agentRead: {} }
  )
  // A reset means the public epoch moved (`/compact`, a non-local rewind) under the cursor.
  if (!frame.result.ok || !frame.agentRead || frame.agentRead.changedSince) {
    throw staleAgentReadCursor(orcaSessionId)
  }
  const { page } = frame.result
  const extent = frame.agentRead
  const shown = pageEntries(page.items, page.hasOlder, request.limit, waiting)
  // Past the oldest item consumed lies more journal unless the frame and journal both ended.
  const olderInJournal =
    page.hasOlder || (shown.consumed !== undefined && shown.consumed !== page.items[0])
  const anchor = olderInJournal ? shown.consumed : undefined
  const clearedBefore = anchor
    ? shown.stop === 'divider'
    : request.clearedFromEarlierSession === true
  const nextCursor = anchor
    ? encodeChatAgentReadCursor(orcaSessionId, {
        sessionId,
        epoch: page.epoch,
        headSequence: extent.headSequence,
        maxOrdinal: extent.maxOrdinal,
        anchor: {
          sequence: anchor.sequence,
          sequenceIndex: anchor.sequenceIndex ?? 0,
          ordinal: ordinalOf(extent, anchor.itemId)
        }
      })
    : null
  const state = position
    ? undefined
    : journalTurnState(
        page.latestTurn,
        frame.acceptedUnopened === true,
        shown,
        page.items.some(
          (item) =>
            (item.body.kind === 'approval' || item.body.kind === 'question') &&
            item.body.resolution.state === 'pending'
        )
      )
  return {
    entries: shown.entries,
    limited: shown.limited,
    nextCursor,
    ...(clearedBefore ? { clearedBefore: true } : {}),
    ...(state ? { state } : {})
  }
}

function ordinalOf(extent: JournalAgentReadExtent, itemId: string): number {
  const ordinal = extent.ordinals[itemId]
  if (ordinal === undefined) {
    throw new Error('agent read page item has no journal ordinal')
  }
  return ordinal
}

type ShownEntries = {
  entries: AgentReadEntry[]
  limited: boolean
  newest?: AgentJournalRenderItem
  /** The oldest item walked past, shown or holding no entry. */
  consumed?: AgentJournalRenderItem
  /** What ended the walk: the limit or budget, a `/clear` divider, or the frame's end. */
  stop: 'full' | 'divider' | 'end'
}

function pageEntries(
  items: readonly AgentJournalRenderItem[],
  hasOlder: boolean,
  limit: number,
  waiting: (itemId: string) => boolean
): ShownEntries {
  const page = new PageBudget(limit)
  const newestFirst: AgentReadEntry[] = []
  let newest: AgentJournalRenderItem | undefined
  let consumed: AgentJournalRenderItem | undefined
  let omitted = false
  const shown = (limited: boolean, stop: ShownEntries['stop']): ShownEntries => ({
    entries: newestFirst.toReversed(),
    limited,
    ...(newest ? { newest } : {}),
    ...(consumed ? { consumed } : {}),
    stop
  })
  for (const item of items.toReversed()) {
    const entry = entryOf(item, waiting)
    if (entry) {
      if (!page.admit(entry)) {
        return shown(true, 'full')
      }
      newestFirst.push(entry)
      newest ??= item
      omitted ||= entry.shortened === true
    }
    consumed = item
    if (isAgentSessionContextClear(item.body)) {
      return shown(omitted, 'divider')
    }
  }
  return shown(omitted || hasOlder, 'end')
}

/** The latest turn as this snapshot records it. `done` only for an explicitly successful turn
 *  whose own reply is the newest entry shown, so a newer prompt never inherits it; unknown
 *  otherwise (failed, interrupted, legacy, or its reply outside this page). */
function journalTurnState(
  latest: AgentSessionLatestTurn | null | undefined,
  acceptedUnopened: boolean,
  shown: ShownEntries,
  unresolvedPrompt: boolean
): AgentStatusState | undefined {
  if (unresolvedPrompt) {
    return undefined
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
