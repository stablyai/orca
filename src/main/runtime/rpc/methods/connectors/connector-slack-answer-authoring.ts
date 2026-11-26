import { ConnectorPrepareSlackAnswer } from '../../../../../shared/rpc-contract/connectors/connector-params'
import {
  CONNECTOR_SLACK_PRESENTATION_FEATURE,
  slackAnswerText
} from '../../../../../shared/connectors/slack-answer-presentation'
import { isQuietBotResult } from '../../../../../shared/bot-quiet-result'
import { botOfSession } from '../../../../bots/bot-session-tabs'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { chatPaneKey } from '../../../../external-conversations/external-conversation-chat'
import { matchingSlackPresentation } from '../../../../connector-cloud/connector-slack-text'
import { sessionCallerOf } from '../../../orchestration/addressing/orchestration-caller-identity'
import { defineMethod, type RpcContext } from '../../core'

export function requireSlackAnswerCaller(context: RpcContext, sessionId: string) {
  const { runtime } = context
  const host = getStructuredAgentSessionHost()
  if (
    !host ||
    sessionCallerOf(context.orchestrationCaller)?.sessionId !== sessionId ||
    !runtime.bots.enabled() ||
    !botOfSession(runtime.bots, sessionId, host)
  ) {
    throw new Error('not_this_bots_conversation')
  }
  if (!runtime.getConnectorCloud()?.cloudFeatures()?.has(CONNECTOR_SLACK_PRESENTATION_FEATURE)) {
    throw new Error('slack_presentation_unavailable')
  }
  return host
}

export const CONNECTOR_PREPARE_SLACK_ANSWER_METHOD = defineMethod({
  name: 'connector.prepareSlackAnswer',
  permission: 'workspace',
  params: ConnectorPrepareSlackAnswer,
  handler: async ({ sessionId, presentation }, context) => {
    const host = requireSlackAnswerCaller(context, sessionId)
    const work = await host.currentWork(sessionId)
    const turn = work?.activeTurn()
    const opener = work?.activeTurnOpener()?.body
    if (!turn || opener?.kind !== 'message') {
      throw new Error('no_current_turn')
    }
    const target = context.runtime
      .getExternalConversationSeam()
      ?.replyTarget(chatPaneKey(sessionId))
    const toSlack =
      opener.connectorDelivery?.conversation.source === 'slack' ||
      opener.connectorClaim?.origin.some(({ conversation }) => conversation.source === 'slack') ||
      (opener.automationRun?.toConversation && target?.key.source === 'slack')
    if (!toSlack) {
      const run = opener.automationRun
      const destination = run && context.runtime.showAutomation(run.automation.id).bot?.resultsTo
      if (
        !destination ||
        (!(typeof destination === 'object' && 'channel' in destination) &&
          !(destination === 'thread' && run?.event?.source === 'slack'))
      ) {
        throw new Error('not_a_cloud_conversation')
      }
    }
    const text = slackAnswerText(presentation)
    if (!matchingSlackPresentation(presentation, text) || isQuietBotResult(text)) {
      throw new Error('invalid_slack_presentation')
    }
    const saved = await host.deps.store
      .connectorReplies()
      .prepareAnswer(
        { sessionId, epoch: work.cursor.epoch, turnItemId: turn.item.itemId },
        presentation
      )
    if (!saved) {
      throw new Error('no_current_turn')
    }
    return { text }
  }
})
