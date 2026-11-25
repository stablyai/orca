import type { z } from 'zod'
import type { ConnectorReply } from '../../../../../shared/rpc-contract/connectors/connector-params'
import { connectorReviewText } from '../../../../../shared/connector-review-text'
import { botTurnFor, sameSession } from '../../../../bots/bot-turn-for'
import { chatPaneKey } from '../../../../external-conversations/external-conversation-chat'
import { connectorPostAttempts } from '../../../../external-conversations/connector-post-attempts'
import type { ReplyTarget } from '../../../../external-conversations/external-conversation-types'
import { sessionCallerOf } from '../../../orchestration/addressing/orchestration-caller-identity'
import type { RpcContext } from '../../core'

export async function replyToFeishu(
  params: z.infer<typeof ConnectorReply>,
  context: RpcContext,
  target: ReplyTarget,
  choices?: string[]
) {
  const caller = sessionCallerOf(context.orchestrationCaller)?.sessionId
  if (
    !('sessionId' in params) ||
    !caller ||
    !sameSession(caller, params.sessionId) ||
    (await botTurnFor(context.runtime, params.sessionId, caller)) !== 'owner'
  ) {
    throw new Error('not_this_bots_conversation')
  }
  const paneKey = chatPaneKey(params.sessionId)
  const current = context.runtime.getExternalConversationSeam()?.replyTarget(paneKey)
  if (
    target.turnId === null ||
    !target.answerDeliveryId ||
    current?.turnId !== target.turnId ||
    current.key.source !== 'feishu-local' ||
    current.key.externalId !== target.key.externalId ||
    current.answerDeliveryId !== target.answerDeliveryId ||
    current.bot?.kind !== 'bot' ||
    current.bot.botId !== target.bot?.botId
  ) {
    throw new Error('no_current_turn')
  }
  const host = context.runtime.feishuLocal
  if (!host) {
    throw new Error('connector_not_connected')
  }
  const { replyId, text, review } = params
  const sent = await host.reply(
    current.bot.botId,
    current.key.externalId,
    current.answerDeliveryId,
    replyId,
    review ? connectorReviewText(text, review) : text,
    choices
  )
  connectorPostAttempts.attempted(paneKey, replyId, current.key.externalId)
  return { ...sent, place: current.place }
}
