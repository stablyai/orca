import { orchestrationMailNotice } from '../../shared/agent-session/journal/agent-session-message-source'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentJournalTurnOpener,
  type AgentJournalTurnOpenerRows
} from '../../shared/agent-session/journal/agent-session-journal-turn-opener'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { AgentSessionJournalReads } from '../native-chat/agent-session-journal/journal-reads'
import { readJournalTurnOpenerRows } from '../native-chat/agent-session-journal/journal-turn-opener-rows'
import { readAutomationRunMessage } from '../../shared/automations/automation-run-message'

/** Resolve the completed request's persisted opener, never a newer turn or a joined delivery. */
/** The ended turn's own row: its lifecycle record, or the item the turn id names. */
export function endedChatTurnRow(
  items: readonly AgentJournalRenderItem[],
  turnId: string
): AgentJournalRenderItem | undefined {
  return items.findLast(
    (item) =>
      isRootAgentJournalItem(item) &&
      (readAgentJournalTurn(item.body)?.turnId === turnId || item.itemId === turnId)
  )
}

export function endedChatTurnOpener(
  journal: AgentJournalTurnOpenerRows,
  turnId: string
): AgentJournalRenderItem | null {
  const request = journal.items.findLast(
    (item) =>
      isRootAgentJournalItem(item) &&
      (readAgentJournalTurn(item.body)?.turnId === turnId || item.itemId === turnId)
  )
  if (!request) {
    return null
  }
  const turn = readAgentJournalTurn(request.body)
  if (!turn) {
    return request.body.kind === 'message' && request.body.role === 'user' ? request : null
  }
  return turn.userItemId ? agentJournalTurnOpener(journal, turn.userItemId) : null
}

/** The ended turn's opener; undefined (unknown, never another turn's) when its aliases can't be read. */
export async function readEndedChatTurnOpener(
  reads: () => Promise<Pick<AgentSessionJournalReads, 'canonicalItemIds'>>,
  items: readonly AgentJournalRenderItem[],
  turnId: string
): Promise<AgentJournalRenderItem | null | undefined> {
  const rows = await reads()
    .then((journal) => readJournalTurnOpenerRows(journal, items))
    .catch(() => null)
  return rows ? endedChatTurnOpener(rows, turnId) : undefined
}

/** Mail a turn opens as its conversation's own ask, as Orca proved when it delivered it: reports to
 *  the Run the chat coordinates from workers its conversation's turns started, and answers to requests
 *  those turns sent other bots, and the runs of waits those turns made. Any other mail (another bot's
 *  own mail, item mail, a worker an Orca-raised turn started) answers in Orca. */
export function isConversationReport(body: AgentJournalRenderItem['body']): boolean {
  if (body.kind !== 'message') {
    return false
  }
  // A wait's run whose wait its conversation's turn made answers where that turn did.
  if (
    body.origin === 'automation-run' &&
    readAutomationRunMessage(body.automationRun)?.toConversation
  ) {
    return true
  }
  const notice = orchestrationMailNotice(body.from)
  const senders = body.from?.senders ?? []
  // Only senders Orca proved; unknown lineage is any other chat's mail.
  return Boolean(
    notice &&
    senders.length > 0 &&
    senders.every(
      (sender) =>
        sender.toConversation && (sender.relation !== 'worker' || notice.mailbox.startsWith('run:'))
    )
  )
}

/** The latest turn's opening message, by position: the fallback when its id can't be resolved. */
export function latestTurnOpener(
  items: readonly AgentJournalRenderItem[]
): AgentJournalRenderItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const body = item?.body
    // A message sent into a running turn joined it; the turn's opener comes before it.
    if (
      item &&
      isRootAgentJournalItem(item) &&
      body?.kind === 'message' &&
      body.role === 'user' &&
      item.turnScope?.kind !== 'turn'
    ) {
      return item
    }
  }
  return null
}
