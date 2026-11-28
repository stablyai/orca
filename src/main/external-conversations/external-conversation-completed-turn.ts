import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { ConversationTurnEnd } from './external-conversation-types'
import {
  turnFailure,
  type ChatTurnEnd,
  type SlackMirrorTurn
} from './external-conversation-turn-ends'
import {
  SLACK_PRESENTATION_UNCONFIRMED,
  slackAnswerText
} from '../../shared/connectors/slack-answer-presentation'

/** A run that took its event thread answers under that thread's existing turn-end post key. */
function linkedSlackRunAnswer(
  end: ChatTurnEnd,
  link: ExternalConversationLink,
  turn: EndedChatTurn,
  words: string | null
) {
  const opener = turn.opener?.body
  if (
    !link.bot ||
    link.source !== 'slack' ||
    end.news.outcome !== 'success' ||
    !words ||
    words !== turn.turnBotProse ||
    opener?.kind !== 'message' ||
    opener.automationRun?.trigger !== 'event' ||
    opener.automationRun.event?.source !== 'slack'
  ) {
    return undefined
  }
  const { slackAnswer } = turn
  return slackAnswer === null || (slackAnswer?.visual && slackAnswerText(slackAnswer) === words)
    ? slackAnswer
    : undefined
}

export async function tellCompletedTurn(
  end: ChatTurnEnd,
  link: ExternalConversationLink,
  turn: EndedChatTurn,
  origin: ConversationTurnEnd['origin'],
  words: string | null,
  links: () => Promise<ConnectorWorkLink[]>,
  mirror: SlackMirrorTurn | null
): Promise<void> {
  const [workLinks] = await Promise.all([links(), end.workersChecked()])
  if (!end.current()) {
    return
  }
  const emit = mirror ? mirror.release : end.emit
  const presentation =
    !mirror && origin === 'delivery' ? linkedSlackRunAnswer(end, link, turn, words) : undefined
  const opener = turn.opener?.body
  const slackAnswerRunId = opener?.kind === 'message' ? opener.automationRun?.runId : undefined
  emit({
    ...end.ended,
    ...end.turnFor(turn),
    ...(origin ? { origin } : {}),
    ...(words
      ? { lastAssistantMessage: presentation === null ? SLACK_PRESENTATION_UNCONFIRMED : words }
      : {}),
    ...(presentation ? { presentation } : {}),
    ...(slackAnswerRunId ? { slackAnswerRunId } : {}),
    ...turnFailure(end, turn),
    ...(workLinks.length > 0 ? { links: workLinks } : {})
  })
  end.leave.settle(mirror ? 'held' : 'end')
}
