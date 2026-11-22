// The card a send to an agent on a paired computer leaves in the asking chat: the same bot-request
// card bot-to-bot requests leave, naming that computer, its outcome read from this Orca's own record.
import { writeInChat } from '../../../../../bots/bot-chat-status-line'
import { isBotRequestPurpose } from '../../../../../bots/bot-request-policy'
import { isBotAnswer } from '../../../../../bots/bot-group-remote-answers'
import { parseBotAddress } from '../../../../../../shared/bot-roster'
import { parseOrcaSessionAddress } from '../../../../../../shared/agent-session/identity/orca-session-address'
import {
  botRequestCardBody,
  type BotRequestCard,
  type BotRequestCardReading
} from '../../../../../../shared/bots/bot-request-card'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

/** Writes the card once the send settles: a chat's question or handoff only, never a terminal's. */
export function clientAskCard(args: {
  asker: string
  to: string
  type: string | undefined
  subject: string
  client: { installationId: string; computer: string }
}): {
  write: (fields: Pick<BotRequestCard, 'messageId' | 'refusal'>) => void
  refused: (error: unknown) => void
} {
  const sessionId = parseOrcaSessionAddress(args.asker)
  const name = parseBotAddress(args.to)
  const write = (fields: Pick<BotRequestCard, 'messageId' | 'refusal'>): void => {
    if (!sessionId || !name || !isBotRequestPurpose(args.type) || args.type === 'status') {
      return
    }
    const card: BotRequestCard = {
      toBotId: name.slice(0, 200),
      toBotName: name.slice(0, 200),
      purpose: args.type,
      subject: args.subject.slice(0, 300),
      client: {
        installationId: args.client.installationId,
        computer: args.client.computer.slice(0, 200)
      },
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

/** How an ask to a paired computer's agent stands here: declined on that computer's notice, answered
 *  by its agent's answer, or not answered when its question settled without one (an unpair or
 *  re-pair notice, shown as the answer is). A handoff, which awaits no answer, takes its first reply. */
export function readClientAskOutcome(
  db: OrchestrationDb,
  messageId: string
): BotRequestCardReading {
  const replies = db.db
    .prepare('SELECT id, body, payload FROM messages WHERE thread_id = ? ORDER BY rowid')
    .all(messageId)
    .map((row) => ({
      id: String(row.id),
      body: String(row.body),
      payload: typeof row.payload === 'string' ? row.payload : null
    }))
  const question = db.db
    .prepare('SELECT awaiting FROM peer_questions_out WHERE message_id = ?')
    .get(messageId)
  const mailIds = replies.map((reply) => reply.id)
  const reading = (outcome: BotRequestCardReading['outcome'], answer?: string) => ({
    outcome,
    answer: answer ?? null,
    mailIds,
    chatId: null
  })
  if (replies.some((reply) => reply.id === `${messageId}_declined`)) {
    return reading('dropped')
  }
  const answer = question ? replies.find((reply) => isBotAnswer(reply, messageId)) : replies[0]
  if (answer) {
    return reading('answered', answer.body)
  }
  return question && question.awaiting === null
    ? reading('dropped', replies.at(-1)?.body)
    : reading(null)
}
