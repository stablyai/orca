// Who or what sent the message that opened a bot's turn: the start its request records
// (bot-request-chain.ts). Read from that message alone, so one steered into the turn never changes
// it; askers, not this, hold a mixed turn to the least trusted.
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { actsForOwner, OWNER_ACTS_FOR, type BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { BotActingTurn, BotActingTurnLookups, ItemReading } from './bot-request-asker'
import { ownerRequestOf } from './bot-owner-request-text'
import { typedOnAnotherDevice, type PersonSends } from './bot-typed-in-orca'

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

/** A message a person, the owner or an automation sent: one that can open a turn's own request. */
export type OpenerEntry = {
  item: AgentJournalRenderItem
  reading: Extract<ItemReading, { kind: 'asker' | 'conversation' }>
}

export function isOpener(entry: {
  item: AgentJournalRenderItem
  reading: ItemReading
}): entry is OpenerEntry {
  return entry.reading.kind === 'asker' || entry.reading.kind === 'conversation'
}

/** A paired device Orca can't place as the owner asked as someone it can't name. */
export function askedByOf(
  entry: OpenerEntry,
  lookups: BotActingTurnLookups
): readonly BotRequestAsker[] {
  return entry.reading.kind === 'asker'
    ? [entry.reading.asker]
    : entry.reading.run
      ? OWNER_ACTS_FOR
      : entry.item.body.kind === 'message' && entry.item.body.memorySource
        ? lookups.conversationActsFor
        : typedOnAnotherDevice(entry.item)
          ? [{ kind: 'unknown' }]
          : OWNER_ACTS_FOR
}

/** The opener alone, so the start's kind, time and words are one message's. */
export function openedFields(
  opener: OpenerEntry,
  lookups: BotActingTurnLookups,
  sends: PersonSends
): Pick<BotActingTurn, 'openedBy' | 'openedAt' | 'ownerRequest'> {
  const ownerRequest = ownerRequestOf(opener.item, sends)
  return {
    openedBy: turnOpenedBy(opener.item.body, askedByOf(opener, lookups)),
    openedAt: opener.item.observedAt,
    ...(ownerRequest ? { ownerRequest } : {})
  }
}
