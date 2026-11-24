import { useMemo } from 'react'
import { Users } from 'lucide-react-native'
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
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { useBotDraftImages } from './use-bot-draft-images'

/** The group composer's `@` members, the room's faces, who the draft reaches, the one bot that would answer, and its photos. */
export function useMobileBotGroupComposer(
  group: BotGroup | undefined,
  bots: readonly Pick<Bot, 'id' | 'name' | 'avatar'>[],
  composerDraft: { key: string; text: string; edit: (change: (text: string) => string) => void },
  client: RpcClient,
  /** The host takes a post's photos; an older one takes text only. */
  takesPhotos: boolean,
  onError: (message: string) => void
) {
  const t = useMobileTranslation()
  const draft = composerDraft.text
  // Photos upload to a member's session, as the desktop's do.
  const uploadTo = takesPhotos ? (group?.members[0]?.sessionId ?? null) : null
  const photos = useBotDraftImages({
    client,
    draftKey: composerDraft.key,
    sessionId: uploadTo,
    editText: composerDraft.edit,
    showToast: onError,
    markersInText: false
  })
  const draftAudience = group ? botGroupDraftAudience(draft, group, bots) : 'invalid'
  // The one bot that would answer, whose agent the composer's commands follow.
  const recipientId =
    draftAudience !== 'invalid' && draftAudience.ids.length === 1 ? draftAudience.ids[0] : null
  const memberBots = useMemo(
    () => bots.filter((bot) => group?.members.some((member) => member.botId === bot.id)),
    [bots, group?.members]
  )
  // This computer's members, then bots on paired computers as the room saved them, as the desktop lists them.
  const roomMentions = useMemo(
    () => [
      ...[...memberBots, ...(group?.remoteMembers ?? [])].map((bot) => ({
        name: bot.name,
        icon: <MobileBotAvatar avatar={mobileBotAvatarSource(bot)} size={20} />
      })),
      { name: 'everyone', icon: <Users size={20} color={colors.textSecondary} strokeWidth={2} /> }
    ],
    [memberBots, group?.remoteMembers]
  )
  // Who is in the room, in the same order, for its picture; a paired computer's upload shows as letters.
  const faces = useMemo(
    () => [
      ...memberBots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        avatar: mobileBotAvatarSource(bot)
      })),
      ...(group?.remoteMembers ?? []).map((bot) => ({
        id: `${bot.environmentId}:${bot.botId}`,
        name: bot.name,
        avatar: mobileBotAvatarSource(bot)
      }))
    ],
    [memberBots, group?.remoteMembers]
  )
  const audience = group ? formatBotGroupAudience(draftAudience, group, bots, t) : ''
  /** Opens the photo library; undefined hides the composer's +. */
  const attachPhotos = uploadTo ? () => void photos.attach() : undefined
  return { recipientId, roomMentions, faces, audience, photos, attachPhotos }
}
