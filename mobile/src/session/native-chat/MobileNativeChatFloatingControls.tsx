import { useEffect, useRef, type ReactNode } from 'react'
import { Animated, Easing, Platform, Pressable, StyleSheet, View } from 'react-native'
import { ArrowDown } from 'lucide-react-native'
import { SHEET_CURVE } from '../../components/sheet-motion-values'
import { useReducedMotionEnabled } from '../../platform/use-reduced-motion'
import { colors, feedback, radii } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { styles } from './mobile-native-chat-view-styles'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { DuoRailControlFrame, DuoRailJumpFrames } from '../../layout/duo-status-row'

const RAIL_ICON_STROKE = 2.1

function jumpEasing() {
  return Easing.bezier(...SHEET_CURVE)
}

const railButton = {
  borderRadius: radii.pill,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  backgroundColor: colors.bgRaised
}

function useShown(shown: boolean): Animated.Value {
  const value = useRef(new Animated.Value(shown ? 1 : 0)).current
  const reducedMotion = useReducedMotionEnabled() === true
  useEffect(() => {
    if (reducedMotion) {
      value.setValue(shown ? 1 : 0)
      return
    }
    const animation = Animated.timing(value, {
      toValue: shown ? 1 : 0,
      duration: shown ? 160 : 120,
      easing: jumpEasing(),
      useNativeDriver: Platform.OS !== 'web'
    })
    animation.start()
    return () => animation.stop()
  }, [reducedMotion, shown, value])
  return value
}

function ChatJumpButton({
  shown,
  shownValue,
  bottom,
  frame,
  label,
  onPress,
  icon
}: {
  shown: boolean
  shownValue: Animated.Value
  bottom?: number | Animated.AnimatedInterpolation<number>
  frame?: {
    top: number | Animated.AnimatedInterpolation<number>
    left: number
    size: number
  }
  label: string
  onPress: () => void
  icon: ReactNode
}): React.JSX.Element {
  const reducedMotion = useReducedMotionEnabled() === true
  const scale = reducedMotion
    ? 1
    : shownValue.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] })
  return (
    <Animated.View
      pointerEvents={shown ? 'box-none' : 'none'}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      style={
        frame
          ? {
              position: 'absolute',
              top: frame.top,
              left: frame.left,
              width: frame.size,
              height: frame.size
            }
          : { position: 'absolute', right: 0, bottom }
      }
    >
      <Animated.View style={{ opacity: shownValue, transform: [{ scale }] }}>
        <Pressable
          accessibilityLabel={shown ? label : undefined}
          disabled={!shown}
          focusable={shown}
          style={({ pressed }) => [
            frame ? railButton : styles.fab,
            frame ? { width: frame.size, height: frame.size } : null,
            pressed && { opacity: feedback.pressedOpacity }
          ]}
          onPress={onPress}
        >
          {/* The glyph is not the control. A page click on the path never reaches onPress. */}
          <View collapsable={false} pointerEvents="none">
            {icon}
          </View>
        </Pressable>
      </Animated.View>
    </Animated.View>
  )
}

function railFrame(
  top: number | Animated.AnimatedInterpolation<number>,
  slot: DuoRailControlFrame
) {
  return { top, left: slot.left, size: slot.size }
}

export function MobileNativeChatFloatingControls({
  showJumpToTail,
  onJumpToTail,
  rail
}: {
  showJumpToTail: boolean
  onJumpToTail: () => void
  rail?: DuoRailJumpFrames | null
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const tailShown = useShown(showJumpToTail)
  const iconSize = rail ? rail.latest.size / 2 : 18
  const iconStroke = rail ? RAIL_ICON_STROKE : 2.2
  return (
    <View pointerEvents="box-none" style={rail ? StyleSheet.absoluteFill : styles.floatingControls}>
      <ChatJumpButton
        shown={showJumpToTail}
        shownValue={tailShown}
        bottom={rail ? undefined : 0}
        frame={rail ? railFrame(rail.latest.top, rail.latest) : undefined}
        label={t('session.nativeChatFloatingControls.scrollToLatest', 'Scroll to latest')}
        onPress={onJumpToTail}
        icon={<ArrowDown size={iconSize} color={colors.textPrimary} strokeWidth={iconStroke} />}
      />
    </View>
  )
}
