import { useEffect, useRef } from 'react'
import { Animated, Easing, Platform, Pressable, StyleSheet, View } from 'react-native'
import { ArrowDown } from 'lucide-react-native'
import { SHEET_CURVE } from '../../../components/motion/sheet-motion-values'
import { useReducedMotionEnabled } from '../../../platform/accessibility/use-reduced-motion'
import { feedback, radii } from '../../../theme/mobile-theme'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'
import { stylesSheet } from '../mobile-native-chat-view-styles'
import { MobileEdgeFade } from '../../../components/list/MobileEdgeFade'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useThemedStyles } from '../../../theme/themed-styles'
import type { DuoRailJumpFrames } from '../../../layout/duo-status-row'

const JUMP_EASING = Easing.bezier(...SHEET_CURVE)
const RAIL_ICON_STROKE = 2.1

/** What floats over the transcript: its edge fades and the jump to the latest message. */
export function MobileNativeChatFloatingControls({
  showJumpToTail,
  onJumpToTail,
  canvasFades = false,
  rail
}: {
  showJumpToTail: boolean
  onJumpToTail: () => void
  /** A chat on the chat canvas; bot screens on other grounds draw none. */
  canvasFades?: boolean
  /** Drawn in the Duo status column instead of over the transcript. */
  rail?: DuoRailJumpFrames | null
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const reducedMotion = useReducedMotionEnabled() === true
  const shown = useRef(new Animated.Value(showJumpToTail ? 1 : 0)).current
  // Stays mounted so a scroll that flips it mid-fade turns the fade around instead of popping.
  useEffect(() => {
    const animation = Animated.timing(shown, {
      toValue: showJumpToTail ? 1 : 0,
      duration: showJumpToTail ? 160 : 120,
      easing: JUMP_EASING,
      useNativeDriver: Platform.OS !== 'web'
    })
    animation.start()
    return () => animation.stop()
  }, [showJumpToTail, shown])
  const scale = reducedMotion ? 1 : shown.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] })
  const iconSize = rail ? rail.latest.size / 2 : 18
  const iconStroke = rail ? RAIL_ICON_STROKE : 2.2
  const button = (
    <Animated.View
      pointerEvents={showJumpToTail ? 'box-none' : 'none'}
      accessibilityElementsHidden={!showJumpToTail}
      importantForAccessibility={showJumpToTail ? 'auto' : 'no-hide-descendants'}
      style={
        rail
          ? {
              position: 'absolute',
              top: rail.latest.top,
              left: rail.latest.left,
              width: rail.latest.size,
              height: rail.latest.size,
              opacity: shown,
              transform: [{ scale }]
            }
          : { opacity: shown, transform: [{ scale }] }
      }
    >
      <Pressable
        accessibilityLabel={
          showJumpToTail
            ? t('session.nativeChatFloatingControls.scrollToLatest', 'Scroll to latest')
            : undefined
        }
        disabled={!showJumpToTail}
        focusable={showJumpToTail}
        style={({ pressed }) => [
          rail
            ? {
                width: rail.latest.size,
                height: rail.latest.size,
                borderRadius: radii.pill,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.bgRaised
              }
            : styles.fab,
          pressed && { opacity: feedback.pressedOpacity }
        ]}
        // A 44 pt target around the 38 pt button.
        hitSlop={rail ? undefined : 3}
        onPress={onJumpToTail}
      >
        <View collapsable={false} pointerEvents="none">
          <ArrowDown size={iconSize} color={colors.textPrimary} strokeWidth={iconStroke} />
        </View>
      </Pressable>
    </Animated.View>
  )
  if (rail) {
    return (
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {button}
      </View>
    )
  }
  return (
    <>
      {/* Rows fade into the canvas under the tabs and above the composer, not at a hard edge. */}
      {canvasFades ? <MobileEdgeFade edge="top" color={colors.chatCanvas} /> : null}
      {canvasFades ? <MobileEdgeFade edge="bottom" color={colors.chatCanvas} /> : null}
      <View pointerEvents="box-none" style={styles.floatingControls}>
        {button}
      </View>
    </>
  )
}
