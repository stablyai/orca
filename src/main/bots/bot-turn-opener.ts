// Who or what sent the message that opened a bot's turn: the start its request records
// (bot-request-chain.ts). Read from that message alone, so one steered into the turn never changes
// it; askers, not this, hold a mixed turn to the least trusted.
import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import { actsForOwner, type BotRequestAsker } from '../../shared/bots/bot-acts-for'

export type BotTurnOpenedBy = 'owner' | 'person' | 'automation'

/** An automation's run or event prompt (or an older run's); otherwise whom the message asks for. */
export function turnOpenedBy(
  body: AgentJournalItemBody,
  askedBy: readonly BotRequestAsker[]
): BotTurnOpenedBy {
  if (body.kind === 'message' && (body.memorySource || body.automationRun)) {
    return 'automation'
  }
  return actsForOwner(askedBy) ? 'owner' : 'person'
}
