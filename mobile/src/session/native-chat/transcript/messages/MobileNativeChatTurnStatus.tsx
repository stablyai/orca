import { MobileBotAvatar } from '../../../../bots/MobileBotAvatar'
import { MobileNativeChatBotIdentityContext } from '../../mobile-native-chat-bot-identity'
import { useContext, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { nativeChatElapsedSeconds } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import {
  formatMobileNativeChatTurnStatusLabel,
  nativeChatTurnStatusCopy
} from './native-chat-turn-status-copy'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import type { AgentTurnOutcome } from '../../../../../../src/shared/agent-status/lifecycle/agent-turn-outcome'
import { feedback, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
import { useNow } from '../../../../hooks/use-now'

// Stop ticking settled turns so old transcripts retain no timers.
function useElapsedSeconds(startedAt: number | null, counting: boolean): number {
  // Preserves the pre-stamp epoch for the frame before the turn's startedAt lands.
  const [mountedAt] = useState(() => Date.now())
  const now = useNow(1_000, counting)
  return counting ? nativeChatElapsedSeconds(startedAt, mountedAt, now) : 0
}

export function MobileNativeChatTurnStatus({
  pendingLabel,
  startedAt,
  workedSeconds,
  verdict,
  expanded = false,
  onToggleExpanded,
  trailing
}: {
  pendingLabel?: string
  startedAt: number | null
  workedSeconds?: number | null
  verdict?: AgentTurnOutcome
  expanded?: boolean
  onToggleExpanded?: () => void
  /** At the row's end, inside its hairline, while the turn is unsettled: a group turn's Stop. */
  trailing?: React.ReactNode
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const bot = useContext(MobileNativeChatBotIdentityContext)
  const settled = workedSeconds != null || Boolean(pendingLabel)
  const elapsedSeconds = useElapsedSeconds(startedAt, !settled)
  const label =
    pendingLabel ??
    formatMobileNativeChatTurnStatusLabel({ workedSeconds, elapsedSeconds, verdict }, t)

  const identity = bot ? (
    <View accessibilityRole="image" accessibilityLabel={bot.name}>
      <MobileBotAvatar avatar={bot.avatar} size={24} />
    </View>
  ) : null

  if (settled && onToggleExpanded) {
    return (
      <Pressable
        style={({ pressed }) => [styles.row, styles.bar, pressed && styles.pressed]}
        onPress={onToggleExpanded}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={
          bot
            ? `${bot.name}, ${label}, ${nativeChatTurnStatusCopy(t).toggleDetails}`
            : nativeChatTurnStatusCopy(t).toggleDetails
        }
      >
        {identity}
        {bot?.showName ? (
          <Text style={styles.name} numberOfLines={1}>
            {bot.name}
          </Text>
        ) : null}
        <Text style={[styles.label, bot?.showName && styles.labelBesideName]} numberOfLines={1}>
          {label}
        </Text>
        <View style={expanded ? styles.caretOpen : undefined}>
          <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} />
        </View>
      </Pressable>
    )
  }

  return (
    <View style={[styles.row, styles.bar]}>
      {identity}
      {bot?.showName ? (
        <Text style={styles.name} numberOfLines={1}>
          {bot.name}
        </Text>
      ) : null}
      <Text style={[styles.label, bot?.showName && styles.labelBesideName]} numberOfLines={1}>
        {label}
      </Text>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 28,
    paddingHorizontal: spacing.md
  },
  bar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  pressed: {
    opacity: feedback.pressedOpacity
  },
  // A room names who spoke, as a chat's header names its agent.
  name: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600',
    flexShrink: 1
  },
  label: {
    color: colors.textMuted,
    fontSize: typography.bodySize,
    flexShrink: 1
  },
  // A long name truncates first, so the status stays whole on its one line.
  labelBesideName: {
    flexShrink: 0,
    maxWidth: '60%'
  },
  trailing: {
    marginLeft: 'auto'
  },
  caretOpen: {
    transform: [{ rotate: '90deg' }]
  }
}))
