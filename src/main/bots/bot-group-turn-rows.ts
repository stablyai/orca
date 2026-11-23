// One room turn's own rows, read once by its operation when its reader opens it.
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { indexBotGroupJournal } from '../../shared/bots/bot-group'
import { requireStructuredHost } from './bot-chat-session'
import { agentJournalItemForWire } from '../native-chat/agent-session-wire/publication/history/agent-session-item-wire-form'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from '../native-chat/agent-session-wire/publication/history/agent-session-history-page-bounds'
import type { BotGroupRuntime } from './bot-group-runtime'

/** The room page draws an ended turn from its saved reply, never from its member chat. The read ends
 *  before the member's next turn, and its rows go in chat history's wire form (tool output fetched on
 *  demand) within one history page, words and turn rows first, so it fits any connection. */
export async function readBotGroupTurnRows(
  groups: BotGroupRuntime,
  groupId: string,
  operationId: string
): Promise<{ items: AgentJournalRenderItem[] }> {
  const message = groups.store.operationMessage(operationId)
  const turn = message?.turns.find((candidate) => candidate.operationId === operationId)
  if (!message || message.groupId !== groupId || !turn) {
    return { items: [] }
  }
  if (turn.frozenItems) {
    return { items: withinHistoryPage(turn.frozenItems) }
  }
  const reads = await (await requireStructuredHost(groups.runtime)).journalReads(turn.sessionId)
  const { snapshot } = await reads.operationWindow({
    operationIds: [operationId],
    anchorsOnly: true,
    throughAnchoredTurns: true,
    withoutToolOutput: true
  })
  return {
    items: withinHistoryPage(indexBotGroupJournal(snapshot)(operationId, turn.workerDispatchIds))
  }
}

function withinHistoryPage(items: readonly AgentJournalRenderItem[]): AgentJournalRenderItem[] {
  const forms = items.map(agentJournalItemForWire)
  let budget = HISTORY_PAGE_CONTENT_BUDGET_BYTES
  const kept = new Set<number>()
  const essential = (item: AgentJournalRenderItem) =>
    item.body.kind === 'turn' || item.body.kind === 'message'
  for (const pass of [true, false]) {
    forms.forEach((form, index) => {
      if (essential(items[index]) === pass && form.bytes <= budget) {
        kept.add(index)
        budget -= form.bytes
      }
    })
  }
  return forms.flatMap((form, index) => (kept.has(index) ? [form.item] : []))
}
