import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { View, Pressable, StyleSheet, Platform, Keyboard } from 'react-native'
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { useSharedValue, useAnimatedStyle } from 'react-native-reanimated'
import { useBackClaim } from '../navigation/use-back-claim'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
// Reuse BottomDrawer’s anchor-independent mount-before-commit gate.
import { resolveBottomDrawerMounted } from './bottom-drawer-mount-state'
import { resolveRightDrawerPanelWidth } from './right-drawer-panel-width'
import {
  bottomDrawerOffset,
  bottomDrawerScrim,
  bottomDrawerTravel
} from './bottom-drawer-drag-motion'
import { hideDrawer, showDrawer, useDrawerDrag } from './use-bottom-drawer-drag'
import { useDrawerReducedMotion } from './bottom-drawer-constants'
import { useResponsiveLayout } from '../layout/responsive-layout'

type Props = {
  visible: boolean
  onClose: () => void
  children: ReactNode
  zIndex?: number
  widthPx?: number
}

export function RightDrawer({ visible, onClose, children, zIndex, widthPx }: Props) {
  const [mounted, setMounted] = useState(visible)
  const resolvedMounted = resolveBottomDrawerMounted(visible, mounted)

  // Mount opening drawer before commit; passive effect adds blank render before animation.
  if (resolvedMounted !== mounted) {
    setMounted(resolvedMounted)
  }

  // Keep Reanimated/Gesture setup out of closed-drawer parent hot paths.
  if (!resolvedMounted) {
    return null
  }

  return (
    <MountedRightDrawer
      visible={visible}
      onClose={onClose}
      onHidden={() => setMounted(false)}
      zIndex={zIndex}
      widthPx={widthPx}
    >
      {children}
    </MountedRightDrawer>
  )
}

type MountedRightDrawerProps = Props & {
  onHidden: () => void
}

function MountedRightDrawer({
  visible,
  onClose,
  onHidden,
  children,
  zIndex = 1000,
  widthPx
}: MountedRightDrawerProps) {
  useMobileColorScheme()
  const progress = useSharedValue(0)
  const fade = useSharedValue(0)
  const reducedMotion = useDrawerReducedMotion()
  const motion = useMemo(() => ({ progress, fade, reducedMotion }), [progress, fade, reducedMotion])
  const { width: screenWidth } = useSafeAreaFrame()
  const insets = useSafeAreaInsets()
  const { isWideLayout } = useResponsiveLayout()
  const panelWidth = resolveRightDrawerPanelWidth(screenWidth, isWideLayout, widthPx)
  const extent = useSharedValue(panelWidth)
  useEffect(() => {
    extent.value = panelWidth
  }, [extent, panelWidth])

  // The panel moves like the bottom sheet, on its own axis: one value, the same curve and release.
  useEffect(() => {
    if (visible) {
      showDrawer(motion)
    } else {
      Keyboard.dismiss()
      hideDrawer(motion, onHidden)
    }
  }, [onHidden, visible])

  // Use native hardware Back or page’s shell Back claim; review route reaches both platform seams.
  useBackClaim(
    visible
      ? () => {
          onClose()
          return true
        }
      : null
  )

  const drag = useDrawerDrag({ ...motion, extent, screenExtent: screenWidth, onDismiss: onClose })
  const scrollGesture = Gesture.Native()
  // Positive horizontal swipe dismisses; activeOffset leaves vertical ScrollView gestures intact.
  const panGesture = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .simultaneousWithExternalGesture(scrollGesture)
    .onBegin(() => drag.begin())
    .onUpdate((e) => drag.follow(e.translationX))
    .onEnd((e) => drag.release(e.velocityX))

  // Web has no worklet plugin; mapper hooks need this explicit dependency list.
  const drawerStyle = useAnimatedStyle(() => {
    const travel = bottomDrawerTravel(extent.value, screenWidth)
    return {
      opacity: fade.value,
      transform: [{ translateX: bottomDrawerOffset(progress.value, travel) }]
    }
  }, [progress, fade, extent, screenWidth])

  const backdropStyle = useAnimatedStyle(() => {
    const travel = bottomDrawerTravel(extent.value, screenWidth)
    return { opacity: fade.value * bottomDrawerScrim(progress.value, travel, extent.value) }
  }, [progress, fade, extent, screenWidth])

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[styles.overlay, { zIndex, elevation: zIndex }]}
      accessibilityViewIsModal
      aria-modal
    >
      <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>

        <View style={styles.anchor} pointerEvents="box-none">
          <GestureDetector gesture={panGesture}>
            <Animated.View
              style={[
                styles.drawer,
                {
                  width: panelWidth,
                  paddingTop: insets.top + spacing.md,
                  paddingBottom: insets.bottom + spacing.lg,
                  paddingRight: insets.right
                },
                drawerStyle
              ]}
            >
              <GestureDetector gesture={scrollGesture}>
                <Animated.ScrollView
                  bounces={false}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  {children}
                </Animated.ScrollView>
              </GestureDetector>
            </Animated.View>
          </GestureDetector>
        </View>
      </GestureHandlerRootView>
    </Animated.View>
  )
}

const styles = themedStyleSheet(() => ({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000
  },
  root: {
    flex: 1
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)'
  },
  anchor: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end'
  },
  drawer: {
    height: '100%',
    backgroundColor: colors.bgBase,
    borderTopLeftRadius: radii.surface,
    borderBottomLeftRadius: radii.surface,
    paddingHorizontal: spacing.md,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.borderSubtle,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: -2, height: 0 },
        shadowOpacity: 0.2,
        shadowRadius: 10
      },
      android: { elevation: 8 }
    })
  }
}))
