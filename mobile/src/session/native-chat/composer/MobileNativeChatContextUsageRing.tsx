import {
  StyleSheet,
  Pressable,
  Text,
  View,
  type HostInstance,
  type LayoutChangeEvent
} from 'react-native'
import { memo, useCallback, useRef, useState } from 'react'
import Svg, { Circle } from 'react-native-svg'
import {
  contextUsageRingReadout,
  keyContextUsageRows,
  type NativeChatContextUsageSummary
} from '../../../../../src/shared/native-chat/native-chat-context-usage-summary'
import { AnchoredDetailCardLayer } from '../../../components/AnchoredDetailCard'
import { DetailCardFocusBoundary } from '../../../components/detail-card-host'
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
import type { MobileHostHandle } from '../../../platform/host-handle'

const RING_SIZE = 16
const RING_STROKE = 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** The composer box's props, which the card lines its trailing and bottom edges up with, and the
 *  ring for the action row (null without usage). `obscured` is the composer's own menu, which sits
 *  where the card would and closes it. */
export function useMobileNativeChatContextRing(
  usage: NativeChatContextUsageSummary | null,
  obscured: boolean
) {
  const ref = useRef<MobileHostHandle>(null)
  const [height, setHeight] = useState(0)
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height),
    []
  )
  // Without usage there is no card to follow the bar, so its height need not re-render the composer.
  return {
    barProps: usage ? { ref, onLayout } : { ref },
    ring: usage ? (
      <MobileNativeChatContextUsageRing
        usage={usage}
        composerRef={ref}
        composerHeight={height}
        obscured={obscured}
      />
    ) : null
  }
}

/** Composer ring for context-window usage; a tap shows the provider's breakdown above the composer.
 *  Memoized so typing in the draft does not redraw it. */
const MobileNativeChatContextUsageRing = memo(function MobileNativeChatContextUsageRing({
  usage,
  composerRef,
  composerHeight,
  obscured
}: {
  usage: NativeChatContextUsageSummary
  composerRef: React.RefObject<HostInstance | null>
  composerHeight: number
  obscured: boolean
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const keyboard = useKeyboardOcclusion()
  const measure = useCallback<DetailCardMeasure>(
    (place) => {
      const composer = composerRef.current
      if (!composer) {
        place(null)
        return
      }
      // A prompt card hides the composer; a zero box means there is nothing to sit above.
      composer.measureInWindow((x, y, width, height) => {
        place(
          width > 0 && height > 0
            ? { side: 'above', right: x + width, bottom: y - spacing.sm }
            : null
        )
      })
    },
    [composerRef]
  )
  // The composer rides the keyboard and grows with the draft; the open card moves with it.
  const card = useAnchoredDetailCard({
    follow: `${keyboard}:${composerHeight}`,
    obscured,
    measure
  })
  useDetailCardScope({ ...card, obscured })
  // Why: the card is a readout; opening or touching it must keep the draft's keyboard up.
  const openerKeepsKeyboard = useKeyboardPersistingTaps('always')
  const cardKeepsKeyboard = useKeyboardPersistingTaps('always')
  const { openerRef, layerRef } = card
  const attachOpener = useCallback(
    (view: HostInstance | null) => {
      openerRef.current = view
      openerKeepsKeyboard(view)
    },
    [openerRef, openerKeepsKeyboard]
  )
  const attachLayer = useCallback(
    (view: HostInstance | null) => {
      layerRef.current = view
      cardKeepsKeyboard(view)
    },
    [layerRef, cardKeepsKeyboard]
  )
  const { filled, critical, used, window } = contextUsageRingReadout(usage)
  const tint = critical ? colors.statusRed : colors.textMuted
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
      <AnchoredDetailCardLayer
        card={card}
        obscured={obscured}
        layerRef={attachLayer}
        title={t('chat.contextUsage.title', 'Context')}
        titleTrailing={`${used}/${window}`}
      >
        <View style={styles.track}>
          <View style={[styles.fill, critical && styles.fillCritical, { width: `${filled}%` }]} />
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
      </AnchoredDetailCardLayer>
    </>
  )
})

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
