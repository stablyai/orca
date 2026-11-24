/** connector.* conversation handlers act on this host's seam, regardless of caller. */

import {
  cloudConversation,
  CONNECTOR_REPLIES_OUTBOX_FEATURE
} from '../../../../../shared/connectors/connector-cloud-contract'
import { botReplyRefusal } from '../../../../external-conversations/external-conversation-bots'
import { ConnectorReply } from '../../../../../shared/rpc-contract/connectors/connector-params'
import type { ExternalConversationSeam } from '../../../../external-conversations/external-conversation-seam'
import { chatPaneKey } from '../../../../external-conversations/external-conversation-chat'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { defineMethod } from '../../core'
import { botTurnFor } from '../../../../bots/bot-turn-for'
import { sessionCallerOf } from '../../../orchestration/addressing/orchestration-caller-identity'
import { CONNECTOR_ACT_METHOD, refuseReplyOutsideTurn } from '../connector-act'
import { CONNECTOR_REACT_METHOD } from '../connector-react'

export function requireSeam(
  runtime: Pick<OrcaRuntimeService, 'getExternalConversationSeam'>
): ExternalConversationSeam {
  const seam = runtime.getExternalConversationSeam()
  if (!seam) {
    throw new Error('connectors_disabled')
  }
  return seam
}

export const CONNECTOR_METHODS = [
  // `orca bot reply`: the calling pane names its cloud conversation and turn; Orca Cloud posts it.
  defineMethod({
    name: 'connector.reply',
    permission: 'workspace',
    params: ConnectorReply,
    handler: async (params, context) => {
      const { replyId, text, review } = params
      const paneKey = 'paneKey' in params ? params.paneKey : chatPaneKey(params.sessionId)
      const target = requireSeam(context.runtime).replyTarget(paneKey)
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
      refuseReplyOutsideTurn(context.runtime, paneKey)
      const conversation = cloudConversation(target.key)
      if (!conversation) {
        throw new Error('not_a_cloud_conversation')
      }
      if (target.turnId === null) {
        throw new Error('no_current_turn')
      }
      const turnFor =
        'sessionId' in params
          ? await botTurnFor(
              context.runtime,
              params.sessionId,
              sessionCallerOf(context.orchestrationCaller)?.sessionId
            )
          : // A terminal pane's reply names no chat whose turn Orca can read.
            'someone_else'
      const cloud = context.runtime.getConnectorCloud()
      // Under replies.outbox a reply naming its turn's request takes that request's answer key.
      const keyed =
        target.answerDeliveryId &&
        cloud?.cloudFeatures()?.has(CONNECTOR_REPLIES_OUTBOX_FEATURE) === true
          ? { answerDeliveryId: target.answerDeliveryId }
          : {}
      const sent = await cloud?.reply({
        replyId,
        conversation,
        turnId: target.turnId,
        text,
        turnFor,
        ...(review ? { review } : {}),
        ...keyed
      })
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
  }),
  CONNECTOR_ACT_METHOD,
  CONNECTOR_REACT_METHOD
]
