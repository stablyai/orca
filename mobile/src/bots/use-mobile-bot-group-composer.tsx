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
import type { MobileBotGroupSession } from './MobileBotGroupTurns'
import type { MobileNativeChatSessionOptionPickersProps } from '../session/native-chat/input/session-options/MobileNativeChatSessionOptionPickers'

/** The group composer's `@` members, who the draft reaches, the one bot whose options apply, and its photos. */
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
    showToast: onError
  })
  const draftAudience = group ? botGroupDraftAudience(draft, group, bots) : 'invalid'
  // Model and permission belong to one bot, so they show only while exactly one would answer.
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
  const audience = group ? formatBotGroupAudience(draftAudience, group, bots, t) : ''
  /** Opens the photo library; undefined hides the composer's +. */
  const attachPhotos = uploadTo ? () => void photos.attach() : undefined
  return { recipientId, roomMentions, audience, photos, attachPhotos }
}

/** The one answering bot's model and permission pickers, as its chat's composer shows them. */
export function mobileBotGroupSessionOptions(
  chosen: MobileBotGroupSession | undefined
): MobileNativeChatSessionOptionPickersProps | undefined {
  return chosen
    ? {
        isWorking: chosen.isWorking,
        controller: {
          snapshot: chosen.optionSnapshot,
          optionSurface: chosen.optionSurface,
          pendingId: null,
          setOption: chosen.setStructuredOption,
          invokeAction: chosen.invokeStructuredOption,
          recordCommand: () => {}
        }
      }
    : undefined
}
