// A connector message sent into a chat first takes its conversation's messages that failed to start
// for the agent's availability (signed out, not set up, an exit while starting). Their
// asker can't see the chat's Retry, so the next message of the conversation carries them into its
// turn, oldest first, each with its own images, as many as one message's image cap takes. The
// admission settles them (journal-domain-carried-cards).
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { NativeChatBlock } from '../../shared/native-chat/native-chat-types'
import { stat } from 'node:fs/promises'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCarriedCard } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import type { ConnectorMessageAsker } from '../../shared/connector-message-asker'
import {
  AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT,
  AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES
} from '../../shared/agent-session/agent-session-attachments'
import { connectorSentLine } from '../../shared/connector-asker-prompt'
import {
  readAgentSessionFailureFact,
  type AgentSessionFailureKind
} from '../../shared/agent-session/failures/agent-session-failure'
import type { JournalReturnedCard } from '../native-chat/agent-session-journal/journal-domain-queue-reads'
import type { ConversationChat } from './external-conversation-chat'
import type { EarlierImageBudget, ConnectorImage } from './connector-asker-images'

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
  earlierBudget: EarlierImageBudget
}

export const NOTHING_CARRIED: CarriedMessages = {
  blocks: [],
  cards: [],
  deliveryIds: [],
  askers: [],
  askedBy: [],
  earlierBudget: {
    count: AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT,
    bytes: AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES,
    fileIds: new Set()
  }
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
export async function carriedMessages(
  link: Pick<ExternalConversationLink, 'source' | 'externalId'>,
  returned: readonly JournalReturnedCard[],
  account: string | undefined,
  now: number,
  direct: readonly ConnectorImage[] = []
): Promise<CarriedMessages> {
  // Oldest first: a failed start's card goes ahead of the queue, so queue order is newest first. A
  // card whose send time is gone came from an earlier Orca, so it is the older.
  const sentAt = (each: JournalReturnedCard) => each.submittedAt ?? Number.NEGATIVE_INFINITY
  const eligible = returned
    .filter((each) => carriesReturnedCard(link, each))
    .toReversed()
    .sort((a, b) => (sentAt(a) === sentAt(b) ? 0 : sentAt(a) < sentAt(b) ? -1 : 1))
  let count = AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT - direct.length
  let bytes =
    AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES -
    direct.reduce((total, image) => total + image.bytes, 0)
  let fileIds = new Set(direct.map((image) => image.fileId))
  const carried: JournalReturnedCard[] = []
  const blocks: NativeChatBlock[] = []
  // Keep the oldest whole requests whose images fit; each remaining card can still be retried.
  for (const each of eligible) {
    const cardFileIds = new Set(fileIds)
    const ownBlocks = each.card.body.blocks.filter((block) => {
      if (block.type !== 'image-ref' || !block.connectorFileId) {
        return true
      }
      if (cardFileIds.has(block.connectorFileId)) {
        return false
      }
      cardFileIds.add(block.connectorFileId)
      return true
    })
    const images = ownBlocks.filter((block) => block.type === 'image-ref')
    if (images.length > count) {
      break
    }
    let cardBytes = 0
    for (const image of images) {
      if (image.url || !image.path) {
        continue
      }
      const size = await stat(image.path).then(
        (info) => (info.isFile() ? info.size : Infinity),
        () => Infinity
      )
      cardBytes += size
      if (cardBytes > bytes) {
        break
      }
    }
    if (cardBytes > bytes) {
      break
    }
    count -= images.length
    bytes -= cardBytes
    fileIds = cardFileIds
    carried.push(each)
    blocks.push(...withSentLine(ownBlocks, each.submittedAt, now))
  }
  return {
    blocks,
    earlierBudget: { count, bytes, fileIds },
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
    askedBy: oncePerSender(
      carried.flatMap(({ card: { body } }) => [
        ...(body.asker
          ? [body.asker]
          : body.origin === 'connector' && !body.memorySource
            ? [null]
            : []),
        ...(body.carriedAskers ?? [])
      ])
    )
  }
}

function withSentLine(blocks: NativeChatBlock[], submittedAt: number | undefined, now: number) {
  const sent =
    submittedAt === undefined
      ? null
      : connectorSentLine({ askedAt: submittedAt, waitedMs: now - submittedAt }, true)
  if (!sent) {
    return blocks
  }
  // A card that carried earlier ones holds their lines before its last text.
  const own = blocks.findLastIndex((block) => block.type === 'text')
  return own === -1
    ? [{ type: 'text' as const, text: sent }, ...blocks]
    : blocks.map((block, index) =>
        index === own && block.type === 'text'
          ? { ...block, text: `${sent}\n${block.text}` }
          : block
      )
}

// A chain of failed starts carries its askers again each time; one stamp per sender keeps it linear.
function oncePerSender(
  askers: readonly (ConnectorMessageAsker | null)[]
): (ConnectorMessageAsker | null)[] {
  const seen = new Set<string>()
  return askers.filter((asker) => {
    // The authority key bot-acts-for's distinctAskers reads: another app is never a role.
    const key = asker ? `${asker.source}:${asker.userId}:${asker.app ? 'app' : asker.role}` : ''
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
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
  direct: readonly ConnectorImage[]
): Promise<CarriedMessages> {
  try {
    const returned = await (
      await chat.conversation(link.sessionId)
    ).journal.queuedMessages.returned()
    return await carriedMessages(link, returned, account, Date.now(), direct)
  } catch (error) {
    console.warn('[connectors] could not read the chat’s unsent messages', error)
    return NOTHING_CARRIED
  }
}
