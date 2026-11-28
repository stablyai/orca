import { MobileBotAvatar } from '../../../../bots/MobileBotAvatar'
import { MobileNativeChatBotIdentityContext } from '../../mobile-native-chat-bot-identity'
import { useContext, useState } from 'react'
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import {
  nativeChatElapsedSeconds,
  type NativeChatTurnStatus
} from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import type { NativeChatBarStatus } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-segments'
import {
  formatMobileNativeChatTurnStatusLabel,
  nativeChatTurnStatusCopy
} from './native-chat-turn-status-copy'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { LoadingSpinner } from '../../../../components/feedback/LoadingSpinner'
import type { AgentTurnOutcome } from '../../../../../../src/shared/agent-status/lifecycle/agent-turn-outcome'
import { feedback, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
import { useNow } from '../../../../hooks/use-now'

// Owner pick pending on option D: true keeps the row's line while it spins in place of "Working…".
const LIVE_ROW_KEEPS_LINE = false

// Stop ticking settled turns so old transcripts retain no timers.
function useElapsedSeconds(startedAt: number | null, counting: boolean): number {
  // Preserves the pre-stamp epoch for the frame before the turn's startedAt lands.
  const [mountedAt] = useState(() => Date.now())
  const now = useNow(1_000, counting)
  return counting ? nativeChatElapsedSeconds(startedAt, mountedAt, now) : 0
}

/** A row's turn bars: its turn's or stretch's under (or above) it, and the turn's own above a row
 *  whose turn opener isn't loaded, which hides nothing to open. */
export function mobileNativeChatTurnStatusRows({
  status,
  lead,
  live,
  expanded,
  onToggle,
  style
}: {
  status: NativeChatBarStatus | null | undefined
  lead: NativeChatTurnStatus | undefined
  live: boolean
  expanded: boolean
  onToggle: (() => void) | undefined
  style: StyleProp<ViewStyle>
}): { statusRow: React.ReactNode; leadRow: React.ReactNode } {
  return {
    statusRow: status ? (
      <MobileNativeChatTurnStatus
        startedAt={status.startedAt}
        workedSeconds={status.workedSeconds}
        verdict={status.verdict}
        continued={status.continued === true}
        live={live}
        style={style}
        expanded={expanded}
        onToggleExpanded={onToggle}
      />
    ) : null,
    leadRow: lead ? (
      <MobileNativeChatTurnStatus
        startedAt={lead.startedAt}
        workedSeconds={lead.workedSeconds}
        verdict={lead.verdict}
        style={style}
      />
    ) : null
  }
}

export function MobileNativeChatTurnStatus({
  pendingLabel,
  startedAt,
  workedSeconds,
  verdict,
  continued = false,
  expanded = false,
  onToggleExpanded,
  trailing,
  live = false,
  style
}: {
  pendingLabel?: string
  startedAt: number | null
  workedSeconds?: number | null
  verdict?: AgentTurnOutcome
  /** Settled: the stretch after the person's message mid-turn, which reads "Continued for". */
  continued?: boolean
  expanded?: boolean
  onToggleExpanded?: () => void
  /** At the row's end, inside its hairline, while the turn is unsettled: a group turn's Stop. */
  trailing?: React.ReactNode
  /** The live line under it would only say "Working…": the row spins in its place, with no line to divide. */
  live?: boolean
  style?: StyleProp<ViewStyle>
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const bot = useContext(MobileNativeChatBotIdentityContext)
  const settled = workedSeconds != null || Boolean(pendingLabel)
  const elapsedSeconds = useElapsedSeconds(startedAt, !settled)
  const label =
    pendingLabel ??
    formatMobileNativeChatTurnStatusLabel({ workedSeconds, elapsedSeconds, verdict, continued }, t)
  const copy = nativeChatTurnStatusCopy(t)

  const identity = bot ? (
    <View accessibilityRole="image" accessibilityLabel={bot.name}>
      <MobileBotAvatar avatar={bot.avatar} size={24} />
    </View>
  ) : null

  if (settled && onToggleExpanded) {
    return (
      <Pressable
        style={({ pressed }) => [styles.row, styles.bar, style, pressed && styles.pressed]}
        onPress={onToggleExpanded}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={
          bot ? `${bot.name}, ${label}, ${copy.toggleDetails}` : `${label}, ${copy.toggleDetails}`
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

  // Standing in for the live line, it announces what that line did, never the ticking clock.
  const spoken = live ? copy.working : label
  return (
    <View
      style={[styles.row, (!live || LIVE_ROW_KEEPS_LINE) && styles.bar, style]}
      // A group turn's Stop sits inside; grouping the row would hide that button.
      accessible={!trailing}
      accessibilityLabel={trailing ? undefined : bot ? `${bot.name}, ${spoken}` : spoken}
      accessibilityLiveRegion={live ? 'polite' : undefined}
    >
      {identity}
      {live ? (
        <View style={styles.spinner}>
          <LoadingSpinner size={12} color={colors.textMuted} />
        </View>
      ) : null}
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
    minHeight: 36,
    paddingHorizontal: spacing.lg
  },
  // Half of the 20 pt gap the line sits in; the line under it gives the other half.
  bar: {
    paddingBottom: 10,
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
  spinner: {
    marginLeft: spacing.xxs
  },
  caretOpen: {
    transform: [{ rotate: '90deg' }]
  }
}))
