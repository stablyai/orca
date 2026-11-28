// Where a bot's background work started, for a turn that later starts on its own (that work finished)
// and so posts nothing by itself: the Slack thread or DM whose delivery opened the starting turn, as
// that turn's origin record (#486) also names it. Chats of their own only (a thread's, a DM's, a
// thread's inside a DM), never the bot's Chat, which answers many conversations.
import type { ReplyTarget } from '../external-conversations/external-conversation-types'
import type { BotWakingPlace } from './bot-request-asker'
import { slackPlaceOf } from '../../shared/connectors/slack-mirror-state'

/** The thread or DM, when the running turn was opened by its conversation's delivery and its origin record
 *  names that same Slack channel; null for anything else. */
export async function wakeReplyPlace(
  botId: string,
  target: ReplyTarget | null,
  // The host's mark that a connector message opened or joined the running turn: the journal's opener
  // alone can't say, as a turn that started on its own reads as the last message's.
  delivered: boolean,
  readOrigin: () => Promise<BotWakingPlace | null>
): Promise<{ place: string } | null> {
  if (
    !delivered ||
    !target?.answerDeliveryId ||
    target.bot?.kind !== 'bot' ||
    target.bot.botId !== botId ||
    target.key.source !== 'slack'
  ) {
    return null
  }
  // A channel thread, a DM, or a thread inside a DM; a bare channel is none of them.
  const slack = slackPlaceOf(target.key.externalId)
  if (!slack) {
    return null
  }
  const origin = await readOrigin()
  return origin?.source === 'slack' && origin.placeId === slack.channelId
    ? { place: target.place }
    : null
}
