import { StyleSheet, Pressable, Text, View } from 'react-native'
import { useCallback } from 'react'
import Svg, { Circle } from 'react-native-svg'
import {
  CONTEXT_USAGE_CRITICAL_PERCENTAGE,
  formatContextTokenCount,
  keyContextUsageRows,
  type NativeChatContextUsageSummary
} from '../../../../../src/shared/native-chat/native-chat-context-usage-summary'
import { AnchoredDetailCard } from '../../../components/AnchoredDetailCard'
import { DetailCardFocusBoundary, DetailCardLayer } from '../../../components/detail-card-host'
import {
  useAnchoredDetailCard,
  type DetailCardMeasure
} from '../../../components/use-anchored-detail-card'
import { useDetailCardScope } from '../../../components/use-detail-card-scope'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles as inputStyles
} from '../../../components/composer-input/composer-input-styles'
import { useKeyboardPersistingTaps } from '../../../platform/keyboard-persisting-taps'
import { useKeyboardOcclusion } from '../../../platform/keyboard-occlusion'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'

const RING_SIZE = 16
const RING_STROKE = 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** Composer ring for context-window usage; a tap shows the provider's breakdown above the composer. */
export function MobileNativeChatContextUsageRing({
  usage,
  composerRef
}: {
  usage: NativeChatContextUsageSummary
  /** The composer box; the card's trailing and bottom edges line up with it. */
  composerRef: React.RefObject<View | null>
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const keyboard = useKeyboardOcclusion()
  const measure = useCallback<DetailCardMeasure>(
    (root, place) => {
      const composer = composerRef.current
      if (!composer) {
        return false
      }
      composer.measureInWindow((x, y, width) => {
        place({ side: 'above', right: x + width - root.x, bottom: y - root.y - spacing.sm })
      })
      return true
    },
    [composerRef]
  )
  // The composer rides the keyboard, so a keyboard change moves the anchor.
  const card = useAnchoredDetailCard({ geometry: String(keyboard), obscured: false, measure })
  useDetailCardScope({ ...card, obscured: false })
  // Why: the card is a readout; opening it must keep the draft's keyboard up.
  const keepsKeyboard = useKeyboardPersistingTaps('always')
  const { openerRef } = card
  const attachOpener = useCallback(
    (view: View | null) => {
      openerRef.current = view
      keepsKeyboard(view)
    },
    [openerRef, keepsKeyboard]
  )
  const filled = Math.min(Math.max(usage.percentage, 0), 100)
  const critical = usage.percentage >= CONTEXT_USAGE_CRITICAL_PERCENTAGE
  const tint = critical ? colors.statusRed : colors.textMuted
  const used = formatContextTokenCount(usage.usedTokens)
  const window = formatContextTokenCount(usage.windowTokens)
  const label = t(
    'chat.contextUsage.label',
    'Context {{used}} of {{window}} tokens, {{percent}}% used',
    { used, window, percent: String(usage.percentage) }
  )
  return (
    <>
      <DetailCardFocusBoundary refs={card.boundaryRefs} index={0} active={card.active} />
      <Pressable
        ref={attachOpener}
        accessibilityRole="button"
        accessibilityLabel={label}
        aria-expanded={card.requestedOpen}
        testID="native-chat-context-usage"
        style={({ pressed }) => [inputStyles.ghostButton, pressed && inputStyles.pressed]}
        onLayout={card.onAnchorLayout}
        onPress={card.toggle}
        hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      >
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
      </Pressable>
      <DetailCardFocusBoundary refs={card.boundaryRefs} index={1} active={card.active} />
      <DetailCardLayer>
        <View
          ref={card.layerRef}
          collapsable={false}
          pointerEvents="box-none"
          onLayout={card.onLayout}
          style={StyleSheet.absoluteFill}
        >
          {card.visual ? (
            <AnchoredDetailCard
              {...card.visual}
              bounds={card.bounds}
              layerHeight={card.layerHeight}
              contentRef={card.contentRef}
              boundaryRefs={card.boundaryRefs}
              active={card.active}
              obscured={false}
              onSettled={card.onSettled}
              title={t('chat.contextUsage.title', 'Context')}
              titleTrailing={`${used}/${window}`}
            >
              <View style={styles.track}>
                <View
                  style={[styles.fill, critical && styles.fillCritical, { width: `${filled}%` }]}
                />
              </View>
              {usage.rows.length > 0 ? (
                <View style={styles.rows}>
                  {keyContextUsageRows(usage.rows).map(({ key, row }) => (
                    <View key={key} style={styles.row}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {row.name}
                      </Text>
                      <Text style={styles.rowValue}>{row.percentage}%</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {usage.estimated ? (
                <Text style={styles.estimated}>
                  {t('chat.contextUsage.estimated', 'Estimated from the last response.')}
                </Text>
              ) : null}
            </AnchoredDetailCard>
          ) : null}
        </View>
      </DetailCardLayer>
    </>
  )
}

const ringStyles = StyleSheet.create({
  ring: { transform: [{ rotate: '-90deg' }] }
})

const styles = themedStyleSheet(() => ({
  track: {
    height: 6,
    marginTop: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    overflow: 'hidden'
  },
  fill: {
    height: '100%',
    borderRadius: radii.pill,
    backgroundColor: colors.textPrimary
  },
  fillCritical: {
    backgroundColor: colors.statusRed
  },
  rows: {
    marginTop: spacing.md,
    gap: spacing.xs
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  rowName: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.metaSize
  },
  rowValue: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontVariant: ['tabular-nums']
  },
  estimated: {
    marginTop: spacing.md,
    color: colors.textMuted,
    fontSize: typography.metaSize
  }
}))
