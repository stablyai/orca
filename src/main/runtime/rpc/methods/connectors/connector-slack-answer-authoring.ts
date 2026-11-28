import { ConnectorPrepareSlackAnswer } from '../../../../../shared/rpc-contract/connectors/connector-params'
import {
  CONNECTOR_SLACK_PRESENTATION_FEATURE,
  slackAnswerText
} from '../../../../../shared/connectors/slack-answer-presentation'
import { reserveSlackRunAnswer, slackAnswerRoute } from '../../../../bots/bot-slack-answer-guidance'
import { botOfSession } from '../../../../bots/bot-session-tabs'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { matchingSlackPresentation } from '../../../../connector-cloud/connector-slack-text'
import { sessionCallerOf } from '../../../orchestration/addressing/orchestration-caller-identity'
import { defineMethod, type RpcContext } from '../../core'

export function requireSlackAnswerCaller(context: RpcContext, sessionId: string) {
  const { runtime } = context
  const host = getStructuredAgentSessionHost()
  if (
    !host ||
    sessionCallerOf(context.orchestrationCaller)?.sessionId !== sessionId ||
    !runtime.bots.enabled()
  ) {
    throw new Error('not_this_bots_conversation')
  }
  if (!runtime.getConnectorCloud()?.cloudFeatures()?.has(CONNECTOR_SLACK_PRESENTATION_FEATURE)) {
    throw new Error('slack_presentation_unavailable')
  }
  if (!botOfSession(runtime.bots, sessionId, host)) {
    throw new Error('not_this_bots_conversation')
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
    if (!slackAnswerRoute(opener)) {
      throw new Error('not_a_cloud_conversation')
    }
    const text = slackAnswerText(presentation)
    if (!matchingSlackPresentation(presentation, text)) {
      throw new Error('invalid_slack_presentation')
    }
    if (
      presentation.visual &&
      opener.automationRun &&
      !reserveSlackRunAnswer(opener.automationRun.runId)
    ) {
      throw new Error('slack_answer_queue_full')
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
