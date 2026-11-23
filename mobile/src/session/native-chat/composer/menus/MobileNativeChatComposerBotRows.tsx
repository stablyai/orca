// The `@` list's bot rows, as the desktop's: a bot with "Chats ›", and one level down "‹ Bot" over its chats.
import { Pressable, Text, View } from 'react-native'
import { ChevronLeft, ChevronRight, RotateCcw } from '../../../../components/icons/app-icons'
import { MobileBotAvatar } from '../../../../bots/MobileBotAvatar'
import { ChatBadgedIcon } from '../../../../bots/MobileBotChatLeading'
import { useNow } from '../../../../hooks/use-now'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, spacing } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { formatTimeAgo } from '../../../../worktree/agent-lineage/agent-row-display'
import type { ComposerMenuRow, MentionBotRow } from './MobileNativeChatComposerMenu'

type BotRow = Extract<MentionBotRow, { kind: 'bot' }>

export function MobileNativeChatComposerBotRow({
  row,
  onPick,
  onOpenChats
}: {
  row: MentionBotRow
  onPick: (row: ComposerMenuRow) => void
  onOpenChats?: (row: BotRow) => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const now = useNow(30_000, row.kind === 'bot-chat')
  const { bot } = row
  switch (row.kind) {
    case 'bot': {
      const note = bot.paused
        ? t('bots.chat.mentionPaused', 'Paused')
        : bot.own
          ? t('bots.chat.mentionOwnChats', 'Your other chats')
          : null
      return (
        <View style={[styles.row, bot.paused && styles.dimmed]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={note ? `${bot.name}, ${note}` : bot.name}
            accessibilityState={{ disabled: bot.paused }}
            disabled={bot.paused}
            style={({ pressed }) => [styles.main, pressed && styles.pressed]}
            onPress={() => onPick(row)}
          >
            <MobileBotAvatar avatar={bot.avatar} size={20} />
            <View style={styles.body}>
              <Text style={styles.name} numberOfLines={1}>
                {bot.name}
              </Text>
              {note ? (
                <Text style={styles.muted} numberOfLines={1}>
                  {note}
                </Text>
              ) : null}
            </View>
          </Pressable>
          {row.chats && onOpenChats ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${bot.name}, ${t('components.native-chat.composer.botChats', 'Chats')}`}
              hitSlop={4}
              style={({ pressed }) => [styles.chats, pressed && styles.pressed]}
              onPress={() => onOpenChats(row)}
            >
              <Text style={styles.muted}>
                {t('components.native-chat.composer.botChats', 'Chats')}
              </Text>
              <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} />
            </Pressable>
          ) : null}
        </View>
      )
    }
    case 'bot-back':
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('components.native-chat.composer.backToBots', 'Back to bots')}
          style={({ pressed }) => [styles.row, styles.main, pressed && styles.pressed]}
          onPress={() => onPick(row)}
        >
          <ChevronLeft size={16} color={colors.textSecondary} strokeWidth={2} />
          <MobileBotAvatar avatar={bot.avatar} size={20} />
          <Text style={[styles.name, styles.body]} numberOfLines={1}>
            {bot.name}
          </Text>
        </Pressable>
      )
    case 'bot-chat': {
      const { chat } = row
      const title = chat.home
        ? t('bots.chats.home', 'Home Chat')
        : chat.title || t('bots.chats.untitled', 'New chat')
      const line = chat.lastSaid ?? chat.lastAsked
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={title}
          style={({ pressed }) => [styles.row, styles.main, pressed && styles.pressed]}
          onPress={() => onPick(row)}
        >
          <ChatBadgedIcon chat={{ origin: chat.home ? 'home' : 'side', live: 'idle' }} />
          <View style={styles.body}>
            <Text style={styles.name} numberOfLines={1}>
              {title}
            </Text>
            {line ? (
              <Text style={styles.muted} numberOfLines={1}>
                {line}
              </Text>
            ) : null}
          </View>
          {chat.lastActivityAt > 0 ? (
            <Text style={styles.muted}>{formatTimeAgo(chat.lastActivityAt, now)}</Text>
          ) : null}
        </Pressable>
      )
    }
    case 'bot-chats-state': {
      const text =
        row.state === 'loading'
          ? t('components.native-chat.composer.loadingBotChats', "Loading {{name}}'s chats…", {
              name: bot.name
            })
          : row.state === 'error'
            ? t('bots.chat.mentionChatsLoadFailed', "Couldn't load chats")
            : row.state === 'none'
              ? t('components.native-chat.composer.noOtherChats', 'No other chats')
              : t('components.native-chat.composer.noMatchingChats', 'No matching chats')
      return (
        <View style={styles.row}>
          <Text style={[styles.muted, styles.body]}>{text}</Text>
          {row.state === 'error' ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={4}
              style={({ pressed }) => [styles.chats, pressed && styles.pressed]}
              onPress={() => onPick(row)}
            >
              <RotateCcw size={13} color={colors.textSecondary} strokeWidth={2} />
              <Text style={styles.retry}>
                {t('components.native-chat.composer.retryChats', 'Retry')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )
    }
  }
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.lg,
    minHeight: 44
  },
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'stretch',
    paddingVertical: spacing.sm
  },
  pressed: {
    backgroundColor: colors.bgRaised
  },
  dimmed: {
    opacity: 0.5
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  name: {
    color: colors.textPrimary,
    fontSize: 14
  },
  muted: {
    color: colors.textMuted,
    fontSize: 12.5
  },
  chats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    alignSelf: 'stretch',
    paddingHorizontal: spacing.xs
  },
  retry: {
    color: colors.textSecondary,
    fontSize: 12.5
  }
}))
