import { useContext, useEffect, useMemo, useRef } from 'react'
import { Animated, Easing, Platform, Pressable, View } from 'react-native'
import { ArrowDown } from 'lucide-react-native'
import { SHEET_CURVE } from '../../components/sheet-motion-values'
import {
  createRepeatingDirectionHandle,
  PaneEdgeNavigationOverlay,
  scrollPaneViewport,
  type EdgeDirection,
  type EdgeNavigationTarget
} from '../../navigation/edge-arrows/edge-navigation-context'
import { AgentSessionEdgeNavContext } from '../../navigation/edge-arrows/edge-navigation-state'
import { useReducedMotionEnabled } from '../../platform/use-reduced-motion'
import { colors, feedback } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { styles } from './mobile-native-chat-view-styles'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'

const JUMP_EASING = Easing.bezier(...SHEET_CURVE)

export function MobileNativeChatFloatingControls({
  showJumpToTail,
  onJumpToTail,
  onBeginUserScroll
}: {
  showJumpToTail: boolean
  onJumpToTail: () => void
  onBeginUserScroll?: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const edgeNav = useContext(AgentSessionEdgeNavContext)
  const callbacksRef = useRef({ onJumpToTail, onBeginUserScroll, edgeNav })
  callbacksRef.current = { onJumpToTail, onBeginUserScroll, edgeNav }

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

  const canNavigateLeft = Boolean(edgeNav?.onNavigateHorizontal)
  const canNavigateRight = Boolean(edgeNav?.onNavigateHorizontal && edgeNav.canNavigateRight)
  const agentSessionTarget = useMemo<EdgeNavigationTarget>(
    () => ({
      id: `agent-session:${edgeNav?.scopeKey ?? 'chat'}:${String(canNavigateRight)}`,
      kind: 'agent-session',
      obscured: edgeNav?.obscured,
      canNavigate: (direction: EdgeDirection) => {
        if (direction === 'left') {
          return canNavigateLeft
        }
        if (direction === 'right') {
          return canNavigateRight
        }
        return true
      },
      preparePress: (direction: EdgeDirection, paneNode?: unknown) => {
        if (direction === 'up') {
          return createRepeatingDirectionHandle(() => {
            callbacksRef.current.onBeginUserScroll?.()
            scrollPaneViewport(paneNode, 'up')
          }, true)
        }
        if (direction === 'down') {
          return createRepeatingDirectionHandle(() => {
            const res = scrollPaneViewport(paneNode, 'down')
            if (res.nearBottom || !res.scrolled) {
              callbacksRef.current.onJumpToTail()
            }
          }, true)
        }
        return createRepeatingDirectionHandle(() => {
          callbacksRef.current.edgeNav?.onNavigateHorizontal?.(direction)
        }, false)
      }
    }),
    [canNavigateLeft, canNavigateRight, edgeNav?.obscured, edgeNav?.scopeKey]
  )

  return (
    <>
      <PaneEdgeNavigationOverlay target={agentSessionTarget} />
      <View pointerEvents="box-none" style={styles.floatingControls}>
        <Animated.View
          pointerEvents={showJumpToTail ? 'box-none' : 'none'}
          accessibilityElementsHidden={!showJumpToTail}
          importantForAccessibility={showJumpToTail ? 'auto' : 'no-hide-descendants'}
          style={{ opacity: shown, transform: [{ scale }] }}
        >
          <Pressable
            accessibilityLabel={
              showJumpToTail
                ? t('session.nativeChatFloatingControls.scrollToLatest', 'Scroll to latest')
                : undefined
            }
            disabled={!showJumpToTail}
            focusable={showJumpToTail}
            style={({ pressed }) => [styles.fab, pressed && { opacity: feedback.pressedOpacity }]}
            onPress={onJumpToTail}
          >
            <ArrowDown size={18} color={colors.textPrimary} strokeWidth={2.2} />
          </Pressable>
        </Animated.View>
      </View>
    </>
  )
}
