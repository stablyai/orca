import type { JournalQueuedMessagesDeps } from './journal-store-contracts'
import type { LegacyQueuedCards } from './journal-queue-import'
import type { JournalQueuePlan } from './journal-queued-messages'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { journalQueueRowBuilder, type JournalQueueCardChange } from './journal-queue-events'
import { journalAttachmentClaimsReceipt } from './journal-submission-hook'

export function journalQueueAdoptionPlan(
  deps: JournalQueuedMessagesDeps,
  legacy: LegacyQueuedCards,
  changes: readonly JournalQueueCardChange[]
): JournalQueuePlan {
  const rows: JournalQueuePlan['rows'] = []
  const adopted: string[] = []
  const bodies: AgentJournalMessageItem[] = []
  for (const { messageId, change } of changes) {
    const own = deps.state().queue.cards.has(messageId) || adopted.includes(messageId)
    const adoption = own ? null : legacy.adoption(messageId)
    if (adoption) {
      bodies.push(adoption.body)
      rows.push(journalQueueRowBuilder(deps.state, messageId, adoption))
      adopted.push(messageId)
    }
    if (change) {
      rows.push(journalQueueRowBuilder(deps.state, messageId, change))
    }
  }
  return {
    rows,
    receipt: journalAttachmentClaimsReceipt(deps.claimAttachments, bodies, legacy.deletion(adopted))
  }
}
