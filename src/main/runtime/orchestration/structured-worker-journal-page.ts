/** Share newest-first journal reads; filter to the worker's own conversation before limiting so child bursts cannot crowd it out. */

import type {
  AgentJournalCursor,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'

export const STRUCTURED_JOURNAL_PAGE_LIMIT = 200

export type StructuredJournalPage = {
  items: readonly AgentJournalRenderItem[]
  hasOlder: boolean
  /** The journal's position after its newest write; a catch-up read from here returns only later writes. */
  liveCursor: AgentJournalCursor
}

/** Read newest journal items; opening a closed conversation starts no agent, and unreadable returns null. */
export async function readStructuredJournalPage(
  sessionId: string,
  limit = STRUCTURED_JOURNAL_PAGE_LIMIT
): Promise<StructuredJournalPage | null> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    const result = await host.history({ sessionId, direction: 'tail', limit }, 'own-agent')
    return structuredJournalPage(result.page)
  } catch {
    return null
  }
}

/** The worker's own conversation on a history page. */
function structuredJournalPage(page: AgentSessionHistoryPage): StructuredJournalPage {
  return {
    items: page.items.filter(isRootAgentJournalItem),
    hasOlder: page.hasOlder,
    // A head-less page restarts catch-up from the epoch's start: repeats, never gaps.
    liveCursor: page.liveCursor ?? { epoch: page.epoch, sequence: 0 }
  }
}

/** Every item written after `cursor`, new or revised in place, plus removals; unreadable returns null. */
export async function readStructuredJournalChanges(
  sessionId: string,
  cursor: AgentJournalCursor,
  limit: number
): Promise<AgentSessionHistoryResult | null> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    // Replay rows as the renderer's catch-up does; normalized history would reset every read.
    return await host.history({ sessionId, direction: 'after', cursor, limit }, 'own-agent', false)
  } catch {
    return null
  }
}

/** Bound the whole lineage oldest-session-first; unreadable current session returns null, while missing earlier history ends the page. */
export async function readStructuredLineageJournalPage(
  lineage: readonly string[]
): Promise<StructuredJournalPage | null> {
  const currentSessionId = lineage.at(-1)
  const current = currentSessionId ? await readStructuredJournalPage(currentSessionId) : null
  if (!currentSessionId || !current) {
    return null
  }
  const items = [...current.items]
  const lineagePage = (hasOlder: boolean): StructuredJournalPage => ({
    items,
    hasOlder,
    liveCursor: current.liveCursor
  })
  if (current.hasOlder) {
    return lineagePage(true)
  }
  for (const sessionId of lineage.slice(0, -1).toReversed()) {
    const remaining = STRUCTURED_JOURNAL_PAGE_LIMIT - items.length
    const page = remaining > 0 ? await readStructuredJournalPage(sessionId, remaining) : null
    if (!page) {
      return lineagePage(true)
    }
    items.unshift(...page.items)
    if (page.hasOlder) {
      return lineagePage(true)
    }
  }
  return lineagePage(false)
}

/** For retired unreadable tails, return the latest readable history and count every skipped session. */
export async function readRetiredLineageJournalPage(
  lineage: readonly string[]
): Promise<{ page: StructuredJournalPage | null; unreadable: number }> {
  for (let unreadable = 1; unreadable < lineage.length; unreadable += 1) {
    const page = await readStructuredLineageJournalPage(lineage.slice(0, -unreadable))
    if (page) {
      return { page, unreadable }
    }
  }
  return { page: null, unreadable: lineage.length }
}
