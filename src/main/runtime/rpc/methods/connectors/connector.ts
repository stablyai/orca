/** connector.* conversation handlers act on this host's seam, regardless of caller. */

import {
  cloudConversation,
  CONNECTOR_REPLIES_OUTBOX_FEATURE
} from '../../../../../shared/connectors/connector-cloud-contract'
import { botReplyRefusal } from '../../../../external-conversations/external-conversation-bots'
import {
  ConnectorReply,
  ConnectorReplySlackAnswer,
  ConnectorWakeReplyPlace,
  CONNECTOR_REPLY_HTML_PAGE_AS_FILE
} from '../../../../../shared/rpc-contract/connectors/connector-params'
import type { ExternalConversationSeam } from '../../../../external-conversations/external-conversation-seam'
import { chatPaneKey } from '../../../../external-conversations/external-conversation-chat'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { defineMethod, type RpcContext } from '../../core'
import type { z } from 'zod'
import { readBotTurnOrigin } from '../orchestration/messaging/bot-turn-origin'
import { wakeReplyPlace } from '../../../../bots/bot-wake-reply-place'
import { botTurnFor } from '../../../../bots/bot-turn-for'
import { sessionCallerOf } from '../../../orchestration/addressing/orchestration-caller-identity'
import { CONNECTOR_ACT_METHOD } from '../connector-act'
import { connectorPostAttempts } from '../../../../external-conversations/connector-post-attempts'
import { CONNECTOR_REACT_METHOD } from '../connector-react'
import { CONNECTOR_LEAVE_THREAD_METHOD } from '../connector-leave-thread'
import { splitSlackHtmlReply } from '../../../../../shared/connectors/slack-html-reply'
import type { ConnectorCloudFeature } from '../../../../../shared/connector-cloud-features'
import { botOfSession } from '../../../../bots/bot-session-tabs'
import { matchingSlackPresentation } from '../../../../connector-cloud/connector-slack-text'
import {
  CONNECTOR_SLACK_PRESENTATION_FEATURE,
  slackAnswerText,
  type SlackAnswerPresentation
} from '../../../../../shared/connectors/slack-answer-presentation'
import {
  CONNECTOR_PREPARE_SLACK_ANSWER_METHOD,
  requireSlackAnswerCaller
} from './connector-slack-answer-authoring'

export function requireSeam(
  runtime: Pick<OrcaRuntimeService, 'getExternalConversationSeam'>
): ExternalConversationSeam {
  const seam = runtime.getExternalConversationSeam()
  if (!seam) {
    throw new Error('connectors_disabled')
  }
  return seam
}

async function replyToConversation(
  params: z.infer<typeof ConnectorReply>,
  context: RpcContext,
  presentation?: SlackAnswerPresentation
) {
  const { replyId, text, review } = params
  const paneKey = 'paneKey' in params ? params.paneKey : chatPaneKey(params.sessionId)
  const seam = requireSeam(context.runtime)
  const target = seam.replyTarget(paneKey)
  if (!target) {
    throw new Error('not_a_cloud_conversation')
  }
  // A bot posts only into the conversation its chat is bound to, as that bot.
  const botRefusal = botReplyRefusal(
    target,
    context.runtime.bots.enabled() ? context.runtime.bots.list() : []
  )
  if (botRefusal) {
    throw new Error(botRefusal)
  }
  const conversation = cloudConversation(target.key)
  if (!conversation) {
    throw new Error('not_a_cloud_conversation')
  }
  if (target.turnId === null) {
    throw new Error('no_current_turn')
  }
  const turnFor =
    'sessionId' in params
      ? await botTurnFor(context.runtime, params.sessionId, {
          verifiedSessionId: sessionCallerOf(context.orchestrationCaller)?.sessionId
        })
      : // A terminal pane's reply names no chat whose turn Orca can read.
        'someone_else'
  const cloud = context.runtime.getConnectorCloud()
  // Slack shows a whole page as an .html file; a caller that asked resends it with the page attached.
  const features = cloud?.cloudFeatures()
  if (
    params.pagesAsFiles &&
    conversation.source === 'slack' &&
    'sessionId' in params &&
    context.runtime.bots.enabled() &&
    (['actions', 'files.direct', 'reply.files'] satisfies ConnectorCloudFeature[]).every(
      (feature) => features?.has(feature)
    ) &&
    botOfSession(context.runtime.bots, params.sessionId) &&
    splitSlackHtmlReply(text) !== null
  ) {
    throw new Error(CONNECTOR_REPLY_HTML_PAGE_AS_FILE)
  }
  // Under replies.outbox a reply naming its turn's request takes that request's answer key.
  const keyed =
    target.answerDeliveryId &&
    cloud?.cloudFeatures()?.has(CONNECTOR_REPLIES_OUTBOX_FEATURE) === true
      ? { answerDeliveryId: target.answerDeliveryId }
      : {}
  if (
    presentation &&
    (conversation.source !== 'slack' ||
      !keyed.answerDeliveryId ||
      !features?.has(CONNECTOR_SLACK_PRESENTATION_FEATURE))
  ) {
    throw new Error('slack_presentation_unavailable')
  }
  const stillAnswering = presentation
    ? () => {
        const current = seam.replyTarget(paneKey)
        return (
          current?.turnId === target.turnId &&
          current.answerDeliveryId === target.answerDeliveryId &&
          current.key.externalId === target.key.externalId
        )
      }
    : undefined
  if (stillAnswering && !stillAnswering()) {
    throw new Error('no_current_turn')
  }
  const refused = connectorPostAttempts.attempted(paneKey, replyId, target.key.externalId)
  const body = {
    replyId,
    conversation,
    turnId: target.turnId,
    text,
    turnFor,
    ...(review ? { review } : {}),
    ...(presentation ? { presentation } : {}),
    ...keyed
  }
  const sent = await (stillAnswering ? cloud?.reply(body, stillAnswering) : cloud?.reply(body))
  // Never sent, or refused outright: nothing reached the thread. A lost answer may have posted.
  if (
    !sent ||
    (!sent.ok && sent.status !== null && sent.status < 500 && sent.error !== 'post_uncertain')
  ) {
    refused()
  }
  if (!sent) {
    throw new Error('connector_not_connected')
  }
  if (!sent.ok) {
    throw new Error(
      sent.error === 'not_this_hosts_thread' ? 'not_this_hosts_thread' : 'connector_unavailable'
    )
  }
  return { ...sent.value, place: target.place }
}

export const CONNECTOR_METHODS = [
  // `orca bot reply`: the calling pane names its cloud conversation and turn; Orca Cloud posts it.
  defineMethod({
    name: 'connector.reply',
    permission: 'workspace',
    params: ConnectorReply,
    handler: (params, context) => replyToConversation(params, context)
  }),
  defineMethod({
    name: 'connector.replySlackAnswer',
    permission: 'workspace',
    params: ConnectorReplySlackAnswer,
    handler: ({ sessionId, replyId, presentation }, context) => {
      requireSlackAnswerCaller(context, sessionId)
      const text = slackAnswerText(presentation)
      if (!matchingSlackPresentation(presentation, text)) {
        throw new Error('invalid_slack_presentation')
      }
      return replyToConversation({ sessionId, replyId, text }, context, presentation)
    }
  }),
  CONNECTOR_PREPARE_SLACK_ANSWER_METHOD,
  // `orca orchestration worker-start`: the thread a later turn of its own may tell, if it wants to.
  defineMethod({
    name: 'connector.wakeReplyPlace',
    permission: 'workspace',
    params: ConnectorWakeReplyPlace,
    handler: async ({ sessionId }, context) => {
      const { runtime } = context
      const bot = runtime.bots.enabled() ? botOfSession(runtime.bots, sessionId) : null
      // Only the chat itself names where its own turn started.
      if (!bot || sessionCallerOf(context.orchestrationCaller)?.sessionId !== sessionId) {
        return { place: null }
      }
      const seam = runtime.getExternalConversationSeam()
      const target = seam?.replyTarget(chatPaneKey(sessionId)) ?? null
      const delivered = seam?.deliveredTurn(sessionId) ?? false
      const placed = await wakeReplyPlace(bot.id, target, delivered, () =>
        readBotTurnOrigin(runtime, runtime.getOrchestrationDb(), sessionId).catch(() => null)
      )
      return placed ?? { place: null }
    }
  }),
  CONNECTOR_ACT_METHOD,
  CONNECTOR_REACT_METHOD,
  CONNECTOR_LEAVE_THREAD_METHOD
]
