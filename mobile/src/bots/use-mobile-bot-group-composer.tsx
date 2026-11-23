import { useMemo } from 'react'
import { AtSign } from 'lucide-react-native'
import type { Bot } from '../../../src/shared/bot-types'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import {
  botGroupDraftAudience,
  formatBotGroupAudience
} from '../../../src/shared/bots/bot-group-mentions'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { MobileBotAvatar } from './MobileBotAvatar'
import { mobileBotAvatarSource } from './host-bot-row-facts'

/** The group composer's `@` members, who the draft reaches, and the one bot whose options apply. */
export function useMobileBotGroupComposer(
  group: BotGroup | undefined,
  bots: readonly Pick<Bot, 'id' | 'name' | 'avatar'>[],
  draft: string
) {
  const t = useMobileTranslation()
  const draftAudience = group ? botGroupDraftAudience(draft, group, bots) : 'invalid'
  // Model and permission belong to one bot, so they show only while exactly one would answer.
  const recipientId =
    draftAudience !== 'invalid' && draftAudience.ids.length === 1 ? draftAudience.ids[0] : null
  const memberBots = useMemo(
    () => bots.filter((bot) => group?.members.some((member) => member.botId === bot.id)),
    [bots, group?.members]
  )
  const roomMentions = useMemo(
    () => [
      ...memberBots.map((bot) => ({
        name: bot.name,
        icon: <MobileBotAvatar avatar={mobileBotAvatarSource(bot, undefined)} size={18} />
      })),
      { name: 'everyone', icon: <AtSign size={16} color={colors.textSecondary} /> }
    ],
    [memberBots]
  )
  const audience = group ? formatBotGroupAudience(draftAudience, group, bots, t) : ''
  return { recipientId, roomMentions, audience }
}
