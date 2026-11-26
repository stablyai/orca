// The picture a shared bot's review shows, as the new bot will look when it keeps the shared picture.
import { isBotMascotId } from '../../../../src/shared/bot-avatar'
import { wornBotOutfit } from '../../../../src/shared/bots/bot-avatar-outfit'
import type { MobileBotAvatarSource } from '../host-bot-row-facts'
import type { PhoneShareReview } from './bot-share-receive-operations'

/** The picture the review shows: the shared image, else its mascot in its shared look, else its first letter. */
export function reviewAvatar(review: {
  avatarDataUrl: PhoneShareReview['avatarDataUrl']
  bot: Pick<PhoneShareReview['bot'], 'name' | 'avatar'>
}): MobileBotAvatarSource {
  const shared = review.bot.avatar
  const mascot = shared?.mascot
  const outfit = wornBotOutfit(shared?.outfit)
  return review.avatarDataUrl
    ? { kind: 'image', uri: review.avatarDataUrl }
    : mascot && isBotMascotId(mascot)
      ? {
          kind: 'mascot',
          id: mascot,
          ...(shared?.color ? { color: shared.color } : {}),
          ...(outfit ? { outfit } : {})
        }
      : { kind: 'text', text: review.bot.name.slice(0, 1).toUpperCase() }
}
