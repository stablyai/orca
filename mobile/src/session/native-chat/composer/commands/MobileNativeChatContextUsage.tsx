import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import {
  contextUsageRingReadout,
  type NativeChatContextUsageSummary
} from '../../../../../../src/shared/native-chat/native-chat-context-usage-summary'
import { ListGroup, ListRow, SectionHeader } from '../../../../components/list/ListGroup'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, pressedStyle, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'

/** Below this share used, context is not worth a line in the composer. */
const NEAR_LIMIT_PERCENTAGE = 80
const RING_SIZE = 16
const RING_STROKE = 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export type MobileNativeChatContext = {
  usage: NativeChatContextUsageSummary | null
  /** Sends the agent's /compact; absent where the agent has none. */
  onCompact?: () => void
}

function contextTint(percentage: number): string {
  return percentage >= NEAR_LIMIT_PERCENTAGE + 10
    ? colors.statusRed
    : percentage >= NEAR_LIMIT_PERCENTAGE
      ? colors.statusAmber
      : colors.textSecondary
}

/** The composer's one context line, shown only near the window's end; the options sheet has the rest. */
export const MobileNativeChatContextLimitLine = memo(function MobileNativeChatContextLimitLine({
  usage,
  onCompact
}: MobileNativeChatContext): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (!usage || usage.percentage < NEAR_LIMIT_PERCENTAGE) {
    return null
  }
  const { filled } = contextUsageRingReadout(usage)
  const tint = contextTint(usage.percentage)
  const left = String(Math.max(0, 100 - Math.round(filled)))
  return (
    <View style={styles.line} testID="native-chat-context-usage">
      <Svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        style={ringStyles.ring}
        pointerEvents="none"
      >
        <Circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke={tint}
          strokeWidth={RING_STROKE}
          opacity={0.25}
        />
        <Circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke={tint}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - filled / 100)}
        />
      </Svg>
      <Text style={[styles.lineText, { color: tint }]} numberOfLines={1}>
        {t('chat.contextUsage.left', '{{percent}}% context left', { percent: left })}
      </Text>
      {onCompact ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={HIT_SLOP}
          onPress={onCompact}
          style={({ pressed }) => pressed && pressedStyle}
        >
          <Text style={styles.compact}>{t('chat.contextUsage.compact', 'Compact')}</Text>
        </Pressable>
      ) : null}
    </View>
  )
})

// The line is 22 pt tall; the slop grows Compact to a 44 pt target.
const HIT_SLOP = { top: 11, bottom: 11, left: spacing.sm, right: spacing.sm }

/** The options sheet's Context section: the share used with its bar, then Compact. */
export function MobileNativeChatContextSection({
  usage,
  onCompact
}: MobileNativeChatContext): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (!usage) {
    return null
  }
  const { filled } = contextUsageRingReadout(usage)
  return (
    <>
      <SectionHeader title={t('chat.contextUsage.title', 'Context')} />
      <ListGroup>
        <ListRow
          key="usage"
          title={t('chat.contextUsage.used', '{{percent}}% used', {
            percent: String(Math.round(filled))
          })}
          detail={
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  { width: `${filled}%`, backgroundColor: contextTint(usage.percentage) }
                ]}
              />
            </View>
          }
        />
        {onCompact ? (
          <ListRow
            key="compact"
            title={t('chat.contextUsage.compact', 'Compact')}
            accent
            onPress={onCompact}
          />
        ) : null}
      </ListGroup>
    </>
  )
}

const ringStyles = StyleSheet.create({
  ring: { transform: [{ rotate: '-90deg' }] }
})

const styles = themedStyleSheet(() => ({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 22,
    paddingHorizontal: 6,
    marginBottom: spacing.sm
  },
  lineText: {
    flex: 1,
    minWidth: 0,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  compact: {
    color: colors.accentBlue,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  track: {
    height: 4,
    marginTop: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    overflow: 'hidden'
  },
  fill: {
    height: '100%',
    borderRadius: radii.pill
  }
}))
