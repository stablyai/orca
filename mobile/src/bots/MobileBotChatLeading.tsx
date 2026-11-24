// A bot chat row's leading glyphs on the phone: its state lane, then where it came from.
import { useId } from 'react'
import { View, type ViewStyle } from 'react-native'
import { Circle, Defs, Mask, Rect } from 'react-native-svg'
import { CalendarClock, House, MessageSquare } from 'lucide-react-native'
import {
  AGENT_STATE_DOT_SIZE,
  AGENT_WORKING_COLOR,
  AgentQuestionIcon,
  AgentStateDot,
  WorkingRing
} from '../agents/presentation/AgentStateDot'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { BotChatTreeChat } from '../../../src/shared/bots/bot-chat-tree'
import type { SuggestionSource } from '../../../src/shared/bots/bot-look-around'
import { MobileConnectorSourceIcon, SOURCE_ICON_VIEW_BOX } from './MobileConnectorSourceIcon'

type LeadingChat = Pick<BotChatTreeChat, 'origin' | 'live'>

/** The chat's own state before its icon, as the desktop's lane: working, waiting on the owner, or nothing. */
export function ChatLeading({ chat }: { chat: BotChatTreeChat }) {
  return (
    <View style={styles.leading}>
      <View style={styles.lane}>
        <ChatStateDot chat={chat} />
      </View>
      <ChatIcon chat={chat} />
    </View>
  )
}

function ChatStateDot({ chat }: { chat: LeadingChat }) {
  return chat.live === 'replying' ? (
    <AgentStateDot state="working" />
  ) : chat.live === 'needs-you' ? (
    <AgentStateDot state="permission" />
  ) : null
}

/** The chat's icon always, its state on the icon's corner (as the desktop sidebar's badge). */
export function ChatBadgedIcon({ chat }: { chat: LeadingChat }) {
  const badgeSize = chat.live === 'needs-you' ? AGENT_STATE_DOT_SIZE : WORKING_BADGE_SIZE
  const size = isSource(chat.origin) ? SOURCE_SIZE : LUCIDE_SIZE
  return (
    <View style={{ width: size, height: size }}>
      <ChatIcon chat={chat} badgeSize={chat.live === 'idle' ? undefined : badgeSize} />
      {chat.live === 'replying' ? (
        <WorkingRing color={AGENT_WORKING_COLOR} style={styles.badgeRing} />
      ) : chat.live === 'needs-you' ? (
        <View style={badgePosition}>
          <AgentQuestionIcon size={badgeSize} />
        </View>
      ) : null}
    </View>
  )
}

const SOURCE_SIZE = 14
const LUCIDE_SIZE = 15

function isSource(origin: BotChatTreeChat['origin']): origin is SuggestionSource {
  return origin === 'slack' || origin === 'linear' || origin === 'github'
}
// The badge sits 2 pt past the icon's corner, with a 1 pt gap cut around it.
const WORKING_BADGE_SIZE = 7
const BADGE_OVERHANG = 2
const badgePosition: ViewStyle = {
  position: 'absolute',
  right: -BADGE_OVERHANG,
  bottom: -BADGE_OVERHANG
}

function useCutout(badgeSize: number | undefined, size: number, viewBox: number) {
  const id = `chat-badge-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  if (badgeSize === undefined) {
    return { mask: undefined, defs: null }
  }
  const unit = viewBox / size
  const center = size - (badgeSize / 2 - BADGE_OVERHANG)
  return {
    mask: `url(#${id})`,
    defs: (
      <Defs>
        <Mask id={id} maskUnits="userSpaceOnUse" x={0} y={0} width={viewBox} height={viewBox}>
          <Rect x={0} y={0} width={viewBox} height={viewBox} fill="white" />
          <Circle
            cx={center * unit}
            cy={center * unit}
            r={(badgeSize / 2 + 1) * unit}
            fill="black"
          />
        </Mask>
      </Defs>
    )
  }
}

function ChatIcon({ chat, badgeSize }: { chat: LeadingChat; badgeSize?: number }) {
  useMobileColorScheme()
  const { mask, defs } = useCutout(
    badgeSize,
    isSource(chat.origin) ? SOURCE_SIZE : LUCIDE_SIZE,
    isSource(chat.origin) ? SOURCE_ICON_VIEW_BOX[chat.origin] : 24
  )
  switch (chat.origin) {
    case 'slack':
    case 'linear':
    case 'github':
      return (
        <MobileConnectorSourceIcon source={chat.origin} mask={mask}>
          {defs}
        </MobileConnectorSourceIcon>
      )
    case 'home':
      return (
        <House size={LUCIDE_SIZE} color={colors.textSecondary} mask={mask}>
          {defs}
        </House>
      )
    case 'automation':
      return (
        <CalendarClock size={LUCIDE_SIZE} color={colors.textSecondary} mask={mask}>
          {defs}
        </CalendarClock>
      )
    case 'side':
      return (
        <MessageSquare size={LUCIDE_SIZE} color={colors.textSecondary} mask={mask}>
          {defs}
        </MessageSquare>
      )
  }
}

/** A chat row's spoken name: title, kind, state; the kind skipped when the title already says it. */
export function useMobileBotChatLabel(chat: LeadingChat, title: string): string {
  const t = useMobileTranslation()
  const kind =
    chat.origin === 'home'
      ? t('bots.chats.home', 'Home Chat')
      : chat.origin === 'slack'
        ? t('bots.chats.kindSlack', 'Slack thread')
        : chat.origin === 'linear'
          ? t('bots.chats.kindLinear', 'Linear issue')
          : chat.origin === 'github'
            ? t('bots.chats.kindGithub', 'GitHub thread')
            : chat.origin === 'automation'
              ? t('bots.chats.kindAutomation', 'Automation run')
              : t('bots.chats.kindSide', 'Side chat')
  const state =
    chat.live === 'replying'
      ? t('bots.chats.replyingState', 'Replying')
      : chat.live === 'needs-you'
        ? t('bots.chats.waiting', 'Waiting for you')
        : null
  return [title, kind === title ? null : kind, state].filter(Boolean).join(', ')
}

const styles = themedStyleSheet(() => ({
  // One width whichever icon follows the lane, so chat titles line up.
  leading: { flexDirection: 'row', alignItems: 'center', gap: 6, width: 10 + 6 + LUCIDE_SIZE },
  lane: { width: 10, alignItems: 'center' },
  badgeRing: {
    ...badgePosition,
    width: WORKING_BADGE_SIZE,
    height: WORKING_BADGE_SIZE,
    borderRadius: radii.pill,
    borderWidth: 2
  }
}))
