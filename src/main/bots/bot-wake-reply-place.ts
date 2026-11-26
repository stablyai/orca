// Where a bot's background work started, for a turn that later starts on its own (that work finished)
// and so posts nothing by itself: the Slack thread or DM whose delivery opened the starting turn, as
// that turn's origin record (#486) also names it. The bot's Chat answers many DMs, so a DM is saved
// for `bot reply --to` only while nothing from another conversation has reached that Chat.
import type {
  ConversationKey,
  ReplyTarget
} from '../external-conversations/external-conversation-types'
import type { BotWakingPlace } from './bot-request-asker'
import { slackPlaceOf, slackThreadUrl } from '../../shared/connectors/slack-mirror-state'

export type WakeReplyPlace = {
  /** The thread or DM, as a bot reads it. */
  place: string
  /** The DM the bot's Chat answers with `bot reply --to <this>`; absent for a thread chat. */
  to?: string
}

type SaveDm = (dm: { key: ConversationKey; openerDeliveryId: string; url: string }) => string | null

/** The place, when the running turn was opened by its conversation's delivery and its origin record
 *  names that same Slack channel; null for anything else. */
export async function wakeReplyPlace(
  botId: string,
  target: ReplyTarget | null,
  // The host's mark that a connector message opened or joined the running turn: the journal's opener
  // alone can't say, as a turn that started on its own reads as the last message's.
  delivered: boolean,
  readOrigin: () => Promise<BotWakingPlace | null>,
  saveDm: SaveDm
): Promise<WakeReplyPlace | null> {
  if (
    !delivered ||
    !target?.answerDeliveryId ||
    target.bot?.botId !== botId ||
    target.key.source !== 'slack'
  ) {
    return null
  }
  const slack = slackPlaceOf(target.key.externalId)
  // A DM's id repeats its channel where a thread's holds its timestamp; a thread inside a DM is neither.
  const [, channel, again] = target.key.externalId.split(':')
  const dm = Boolean(slack?.channelId.startsWith('D'))
  const bare = dm && !slack?.threadTs && again === channel
  if (!slack || (target.bot.kind === 'bot' ? dm || !slack.threadTs : !bare)) {
    return null
  }
  const origin = await readOrigin()
  if (origin?.source !== 'slack' || origin.placeId !== slack.channelId) {
    return null
  }
  if (target.bot.kind === 'bot') {
    return { place: target.place }
  }
  const url = slackThreadUrl(target.key.externalId)
  const to = url && saveDm({ key: target.key, openerDeliveryId: target.answerDeliveryId, url })
  return to ? { place: target.place, to } : null
}
