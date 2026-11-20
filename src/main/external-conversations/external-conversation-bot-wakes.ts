// Another Orca bot's post waking a bot in a thread: counted in a row per bot, back to the last time a
// person wrote to any bot of this computer's in that thread, so one reply lets every bot there go on.
import type { ConnectorAsker } from '../../shared/connector-asker-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { botWakesInARow } from '../bots/bot-chain-messages'
import {
  BOT_CHAIN_LIMIT,
  botWakeChain,
  botWakeStoppedChatLine,
  noteLimitOnce
} from '../bots/bot-request-limits'
import type { ConversationChat } from './external-conversation-chat'

// When a person last wrote to a bot here, by thread; lost on restart, when each chat's own count holds.
const personWroteAt = new Map<string, number>()

/** A Slack conversation is one bot's in one thread (workspace:channel:thread:bot); other sources' are
 *  the thread's own. */
function threadOf(link: Pick<ExternalConversationLink, 'source' | 'externalId'>): string {
  const id =
    link.source === 'slack' ? link.externalId.split(':').slice(0, 3).join(':') : link.externalId
  return `${link.source}:${id}`
}

/** A person's own message the chat took starts every bot's count in the thread again; one refused or
 *  never taken starts none. */
export function notePersonWrote(
  link: Pick<ExternalConversationLink, 'source' | 'externalId' | 'bot'>,
  asker: ConnectorAsker | undefined
): void {
  if (asker && !asker.via && link.bot) {
    personWroteAt.set(threadOf(link), Date.now())
  }
}

/** What another bot's post does to its bot's chain: past the limit it isn't delivered (`stop`), and
 *  the last one allowed carries Orca's note to stop. */
export async function botWakeGate(
  chat: ConversationChat,
  link: Pick<ExternalConversationLink, 'source' | 'externalId' | 'sessionId' | 'bot'>,
  asker: ConnectorAsker | undefined,
  deliveryId: string | undefined
): Promise<{ kind: 'stop' } | { kind: 'deliver'; note?: string }> {
  if (!asker?.via || !link.bot) {
    return { kind: 'deliver' }
  }
  const since = personWroteAt.get(threadOf(link)) ?? 0
  const chain = botWakeChain((await botWakesBefore(chat, link.sessionId, since)) + 1)
  if (chain.kind === 'stop') {
    const key = deliveryId ? JSON.stringify([link.source, link.externalId, deliveryId]) : undefined
    noteLimitOnce(link.sessionId, key, botWakeStoppedChatLine(asker.via.name))
    return { kind: 'stop' }
  }
  return chain.kind === 'last' ? { kind: 'deliver', note: chain.note } : { kind: 'deliver' }
}

/** Read wider until a person's message or the limit decides it. Unreadable, it counts none, so a post
 *  is never lost. */
async function botWakesBefore(
  chat: ConversationChat,
  sessionId: string,
  since: number
): Promise<number> {
  try {
    const reads = await chat.journalReads(sessionId)
    for (let latestTurns = 16; ; latestTurns *= 4) {
      const { snapshot, complete } = await reads.operationWindow({ latestTurns, turnShape: true })
      const counted = botWakesInARow(snapshot.items, BOT_CHAIN_LIMIT, since)
      if (counted.decided || complete) {
        return counted.wakes
      }
    }
  } catch {
    return 0
  }
}
