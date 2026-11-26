import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import {
  turnFailure,
  type ChatTurnEnd,
  type SlackMirrorTurn
} from './external-conversation-turn-ends'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** A run that took its event thread answers under that thread's existing turn-end post key. */
async function linkedSlackRunAnswer(
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
    opener.automationRun.event?.source !== 'slack' ||
    !turn.journalEpoch ||
    !turn.turnItemId
  ) {
    return undefined
  }
  return getStructuredAgentSessionHost()
    ?.deps.store.connectorReplies()
    .answerPresentation(
      { sessionId: end.news.sessionId, epoch: turn.journalEpoch, turnItemId: turn.turnItemId },
      words
    )
    .catch(() => undefined)
}

export async function tellCompletedTurn(
  end: ChatTurnEnd,
  link: ExternalConversationLink,
  turn: EndedChatTurn,
  origin: ChatTurnEnd['ended']['origin'],
  words: string | null,
  links: () => Promise<ConnectorWorkLink[]>,
  mirror: SlackMirrorTurn | null
): Promise<void> {
  const [workLinks, presentation] = await Promise.all([
    links(),
    !mirror && origin === 'delivery' ? linkedSlackRunAnswer(end, link, turn, words) : undefined,
    end.workersChecked()
  ])
  if (!end.current()) {
    return
  }
  const emit = mirror ? mirror.release : end.emit
  emit({
    ...end.ended,
    ...end.turnFor(turn),
    ...(origin ? { origin } : {}),
    ...(words ? { lastAssistantMessage: words } : {}),
    ...(presentation ? { presentation } : {}),
    ...turnFailure(end, turn),
    ...(workLinks.length > 0 ? { links: workLinks } : {})
  })
  end.leave.settle(mirror ? 'held' : 'end')
}
