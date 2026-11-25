// A connector message sent into a chat first takes its conversation's messages that failed to start
// for the agent's availability (signed out, not set up, an exit while starting). Their
// asker can't see the chat's Retry, so the next message of the conversation carries them into its
// turn, oldest first, each with its own images. The admission settles them (journal-domain-carried-cards).
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { NativeChatBlock } from '../../shared/native-chat/native-chat-types'
import type { AgentJournalCarriedCard } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import type { ConnectorMessageAsker } from '../../shared/connector-message-asker'
import { connectorSentLine } from '../../shared/connector-asker-prompt'
import {
  readAgentSessionFailureFact,
  type AgentSessionFailureKind
} from '../../shared/agent-session/failures/agent-session-failure'
import type { JournalReturnedCard } from '../native-chat/agent-session-journal/journal-domain-queue-reads'
import type { ConversationChat } from './external-conversation-chat'

// What a later send can get past: the agent itself couldn't take the message. A refusal of the
// message's own content (too large, too many images, empty) would fail again, so it stays a card.
// A usage limit never returns a message: it cuts the turn, which its auto-continue sends again.
const AVAILABILITY_FAILURES: ReadonlySet<AgentSessionFailureKind> = new Set([
  'notSignedIn',
  'cliMissing',
  'runtimeNotInstalled',
  'agentCommandNotRunnable',
  'claudeAccountFolderMissing',
  'claudeAccountSetupFailed',
  'providerStartFailed'
])

export type CarriedMessages = {
  /** Each carried message's blocks in order, its sent line first and its own images after. */
  blocks: NativeChatBlock[]
  cards: AgentJournalCarriedCard[]
  /** Their reply rows on the same account, which this turn now answers. */
  deliveryIds: string[]
  askers: (ConnectorMessageAsker | undefined)[]
}

export const NOTHING_CARRIED: CarriedMessages = {
  blocks: [],
  cards: [],
  deliveryIds: [],
  askers: []
}

/** Whether a returned card is one this conversation's next message carries. */
export function carriesReturnedCard(
  link: Pick<ExternalConversationLink, 'source' | 'externalId'>,
  { card, editHeld }: JournalReturnedCard
): boolean {
  const { body } = card
  const kind = readAgentSessionFailureFact(card.returnedRejection)?.kind
  return (
    !editHeld &&
    card.state === 'returned' &&
    !body.command &&
    !body.from &&
    !body.connectorClaim &&
    body.connectorConversation?.source === link.source &&
    body.connectorConversation.externalId === link.externalId &&
    kind !== undefined &&
    AVAILABILITY_FAILURES.has(kind)
  )
}

/** The carried cards as the turn takes them, ahead of its own message; `account` is the outbox
 *  account the turn answers through, if any. */
export function carriedMessages(
  link: Pick<ExternalConversationLink, 'source' | 'externalId'>,
  returned: readonly JournalReturnedCard[],
  account: string | undefined,
  now: number
): CarriedMessages {
  // Oldest first: a failed start's card goes ahead of the queue, so queue order is newest first. A
  // card whose send time is gone came from an earlier Orca, so it is the older.
  const sentAt = (each: JournalReturnedCard) => each.submittedAt ?? Number.NEGATIVE_INFINITY
  const carried = returned
    .filter((each) => carriesReturnedCard(link, each))
    .toReversed()
    .sort((a, b) => (sentAt(a) === sentAt(b) ? 0 : sentAt(a) < sentAt(b) ? -1 : 1))
  if (carried.length === 0) {
    return NOTHING_CARRIED
  }
  return {
    blocks: carried.flatMap(({ card, submittedAt }) => {
      const sent =
        submittedAt === undefined
          ? null
          : connectorSentLine({ askedAt: submittedAt, waitedMs: now - submittedAt }, true)
      // On its own words: a card that carried earlier ones holds their lines before its last text.
      const own = card.body.blocks.findLastIndex((block) => block.type === 'text')
      if (!sent) {
        return card.body.blocks
      }
      return own === -1
        ? [{ type: 'text' as const, text: sent }, ...card.body.blocks]
        : card.body.blocks.map((block, index) =>
            index === own && block.type === 'text'
              ? { ...block, text: `${sent}\n${block.text}` }
              : block
          )
    }),
    cards: carried.map(({ card }) => ({
      messageId: card.messageId,
      fingerprint: card.fingerprint
    })),
    deliveryIds: carried.flatMap(({ card }) => {
      const stamp = card.body.connectorDelivery
      return stamp && stamp.account === account ? [stamp.deliveryId, ...(stamp.carried ?? [])] : []
    }),
    askers: carried.map(({ card }) => card.body.asker)
  }
}

/** The chat's returned cards this conversation's message carries; none when the chat can't say. */
export async function readCarriedMessages(
  chat: ConversationChat,
  link: Pick<ExternalConversationLink, 'sessionId' | 'source' | 'externalId'>,
  account: string | undefined
): Promise<CarriedMessages> {
  try {
    const returned = await (
      await chat.conversation(link.sessionId)
    ).journal.queuedMessages.returned()
    return carriedMessages(link, returned, account, Date.now())
  } catch (error) {
    console.warn('[connectors] could not read the chat’s unsent messages', error)
    return NOTHING_CARRIED
  }
}
