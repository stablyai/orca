// Where a bot's background work started, for a turn that later starts on its own (that work finished)
// and so posts nothing by itself: the Slack thread whose delivery opened the starting turn, as that
// turn's origin record (#486) also names it. Thread chats only; the bot's Chat answers many DMs.
import type { ReplyTarget } from '../external-conversations/external-conversation-types'
import type { BotWakingPlace } from './bot-request-asker'
import { slackPlaceOf } from '../../shared/connectors/slack-mirror-state'

/** The thread, when the running turn was opened by its conversation's delivery and its origin record
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
  const slack = slackPlaceOf(target.key.externalId)
  // A thread inside a DM is DM territory, a later stage.
  if (!slack?.threadTs || slack.channelId.startsWith('D')) {
    return null
  }
  const origin = await readOrigin()
  return origin?.source === 'slack' && origin.placeId === slack.channelId
    ? { place: target.place }
    : null
}
