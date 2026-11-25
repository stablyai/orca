// A connector message sent into a chat first takes its conversation's messages that failed to start
// for the agent's availability (signed out, not set up, an exit while starting). Their
// asker can't see the chat's Retry, so the next message of the conversation carries them into its
// turn, oldest first, each with its own images, as many as one message's image cap takes. The
// admission settles them (journal-domain-carried-cards).
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { NativeChatBlock } from '../../shared/native-chat/native-chat-types'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCarriedCard } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import type { ConnectorMessageAsker } from '../../shared/connector-message-asker'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../../shared/agent-session/agent-session-attachments'
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
  /** For the leave mark: each card's asker, only when its own batch could leave the thread. */
  askers: (ConnectorMessageAsker | undefined)[]
  /** Everyone who asked a carried message, nested carries included; null for one Orca can't name. */
  askedBy: (ConnectorMessageAsker | null)[]
}

export const NOTHING_CARRIED: CarriedMessages = {
  blocks: [],
  cards: [],
  deliveryIds: [],
  askers: [],
  askedBy: []
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
 *  account the turn answers through, if any, and `ownImages` the images the message brings. */
export function carriedMessages(
  link: Pick<ExternalConversationLink, 'source' | 'externalId'>,
  returned: readonly JournalReturnedCard[],
  account: string | undefined,
  now: number,
  ownImages = 0
): CarriedMessages {
  // Oldest first: a failed start's card goes ahead of the queue, so queue order is newest first. A
  // card whose send time is gone came from an earlier Orca, so it is the older.
  const sentAt = (each: JournalReturnedCard) => each.submittedAt ?? Number.NEGATIVE_INFINITY
  const eligible = returned
    .filter((each) => carriesReturnedCard(link, each))
    .toReversed()
    .sort((a, b) => (sentAt(a) === sentAt(b) ? 0 : sentAt(a) < sentAt(b) ? -1 : 1))
  // Oldest first while the images fit one message; the rest stay returned for the next message.
  let images = ownImages
  const over = eligible.findIndex(({ card }) => {
    images += card.body.blocks.filter((block) => block.type === 'image-ref').length
    return images > AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT
  })
  const carried = over === -1 ? eligible : eligible.slice(0, over)
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
    // A batch that couldn't leave the thread stays unable to when carried again.
    askers: carried.map(({ card }) =>
      card.body.leaveEligible === true ? card.body.asker : undefined
    ),
    askedBy: carried.flatMap(({ card: { body } }) => [
      ...(body.asker
        ? [body.asker]
        : body.origin === 'connector' && !body.memorySource
          ? [null]
          : []),
      ...(body.carriedAskers ?? [])
    ])
  }
}

/** What the carrying message keeps beside its blocks: the cards its admission settles, and who asked
 *  them, so its turn acts for the least trusted (bot-request-asker). */
export function carriedFields({
  cards,
  askedBy
}: CarriedMessages): Pick<AgentJournalMessageItem, 'carriedCards' | 'carriedAskers'> {
  return {
    ...(cards.length > 0 ? { carriedCards: cards } : {}),
    ...(askedBy.length > 0 ? { carriedAskers: askedBy } : {})
  }
}

/** The chat's returned cards this conversation's message carries; none when the chat can't say. */
export async function readCarriedMessages(
  chat: ConversationChat,
  link: Pick<ExternalConversationLink, 'sessionId' | 'source' | 'externalId'>,
  account: string | undefined,
  ownImages: number
): Promise<CarriedMessages> {
  try {
    const returned = await (
      await chat.conversation(link.sessionId)
    ).journal.queuedMessages.returned()
    return carriedMessages(link, returned, account, Date.now(), ownImages)
  } catch (error) {
    console.warn('[connectors] could not read the chat’s unsent messages', error)
    return NOTHING_CARRIED
  }
}
