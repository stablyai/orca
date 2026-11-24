// The card a bot's request leaves in the chat that sent it: Orca's line of what was sent and to whom,
// or why it wasn't, never the bot's. Connector conversations' turns, workers' requests, group rooms
// and status mail get none.
import { writeInChat } from '../../../../../bots/bot-chat-status-line'
import { answeredOnCard, type BotRequestRecord } from '../../../../../bots/bot-request-view'
import { isBotRequestPurpose } from '../../../../../bots/bot-request-policy'
import {
  botRequestCardBody,
  type BotRequestCard
} from '../../../../../../shared/bots/bot-request-card'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { toOtherChat, type ActingSender, type ReceivingBot } from './bot-recipient'

export function ownerChatCard(
  acting: ActingSender,
  receiving: ReceivingBot,
  params: { type?: string; subject: string },
  asked: Pick<BotRequestRecord, 'askedInConversation'>
): {
  write: (fields: Pick<BotRequestCard, 'messageId' | 'refusal'>) => void
  refused: (error: unknown) => void
} {
  const target = receiving.bot
  // A worker's request is the worker's: its answer comes back to the worker, not the chat.
  const sessionId =
    !acting.worker &&
    acting.bot &&
    acting.sessionId &&
    !acting.sessionId.startsWith('bot-group-member-') &&
    (target.id !== acting.bot.id || toOtherChat(receiving, acting.sessionId)) &&
    answeredOnCard(asked)
      ? acting.sessionId
      : null
  const write = (fields: Pick<BotRequestCard, 'messageId' | 'refusal'>): void => {
    if (!sessionId || !isBotRequestPurpose(params.type) || params.type === 'status') {
      return
    }
    const card: BotRequestCard = {
      toBotId: target.id,
      toBotName: target.name,
      purpose: params.type,
      subject: params.subject.slice(0, 300),
      ...fields
    }
    writeInChat(sessionId, botRequestCardBody(card), 'bot-request')
  }
  return {
    write,
    refused: (error) => {
      if (error instanceof OrchestrationError) {
        write({ refusal: error.code })
      }
    }
  }
}
