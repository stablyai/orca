import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions
} from 'react-native'
import { Check } from 'lucide-react-native'
import { useReducedMotionEnabled } from '../../platform/use-reduced-motion'
import { useBackClaim } from '../../navigation/use-back-claim'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { ActionSheetAction } from '../ActionSheetModal'

const MENU_WIDTH = 252
const ANCHOR_GAP = 6
const EDGE_INSET = 8
// About 250 ms to rest with a hint of overshoot, like an iOS menu growing out of its button.
const OPEN_SPRING = { stiffness: 420, damping: 32, mass: 1 }
const CLOSE_FADE_MS = 150

// Below the button, or above it when the button sits in the lower half, so the menu never runs off-screen.
type Anchor = { top: number; right: number } | { bottom: number; right: number }

type PullDownMenuProps = {
  visible: boolean
  /** The button the menu drops from. */
  anchorRef: RefObject<View | null>
  /** Groups are separated by a thicker divider, like an iOS menu's sections. */
  groups: readonly (readonly ActionSheetAction[])[]
  onClose: () => void
}

// The iOS pull-down: a small menu dropping from the button that opened it, instead of a sheet from the bottom.
export function PullDownMenu({ visible, anchorRef, groups, onClose }: PullDownMenuProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const window = useWindowDimensions()
  const reducedMotion = useReducedMotionEnabled()
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  // The Modal outlives `visible` by the exit fade, so the menu fades out instead of vanishing.
  const [presented, setPresented] = useState(visible)
  if (visible && !presented) {
    setPresented(true)
  }
  const pendingRef = useRef<(() => void) | null>(null)
  const appear = useRef(new Animated.Value(0)).current

  useLayoutEffect(() => {
    if (!visible) {
      return
    }
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      const right = Math.max(EDGE_INSET, window.width - (x + width))
      setAnchor(
        y + height / 2 > window.height / 2
          ? { bottom: window.height - y + ANCHOR_GAP, right }
          : { top: y + height + ANCHOR_GAP, right }
      )
    })
  }, [anchorRef, visible, window.width, window.height])

  useEffect(() => {
    if (!visible || anchor === null) {
      return
    }
    appear.setValue(0)
    const open =
      reducedMotion === true
        ? Animated.timing(appear, {
            toValue: 1,
            duration: CLOSE_FADE_MS,
            useNativeDriver: Platform.OS !== 'web'
          })
        : Animated.spring(appear, {
            toValue: 1,
            ...OPEN_SPRING,
            useNativeDriver: Platform.OS !== 'web'
          })
    open.start()
    return () => open.stop()
  }, [anchor, appear, reducedMotion, visible])

  useEffect(() => {
    if (visible || !presented) {
      return
    }
    const close = Animated.timing(appear, {
      toValue: 0,
      duration: CLOSE_FADE_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== 'web'
    })
    close.start(({ finished }) => {
      if (finished) {
        setPresented(false)
        setAnchor(null)
      }
    })
    return () => close.stop()
  }, [appear, presented, visible])

  // An action that opens its own sheet runs once the menu's modal is gone; iOS can't present over it.
  useEffect(() => {
    if (presented || !pendingRef.current) {
      return
    }
    const run = pendingRef.current
    pendingRef.current = null
    const frame = requestAnimationFrame(run)
    return () => cancelAnimationFrame(frame)
  }, [presented])

  const press = (action: ActionSheetAction) => {
    if (action.closeBeforePress) {
      pendingRef.current = action.onPress
      onClose()
      return
    }
    action.onPress()
    if (!action.skipAutoClose) {
      onClose()
    }
  }

  // The page's Back (Android, the iOS edge swipe) closes the menu before the screen under it.
  useBackClaim(
    visible
      ? () => {
          onClose()
          return true
        }
      : null
  )
  const shown = groups.map((group) => group.filter(Boolean)).filter((group) => group.length > 0)
  return (
    <Modal visible={presented} transparent animationType="none" onRequestClose={onClose}>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        disabled={!visible}
        accessibilityLabel={t('components.pullDownMenu.close', 'Close menu')}
      />
      {anchor ? (
        <Animated.View
          style={[
            styles.menu,
            anchor,
            // Long menus scroll instead of running off a short (landscape) screen.
            {
              maxHeight: window.height - ('top' in anchor ? anchor.top : anchor.bottom) - EDGE_INSET
            },
            {
              opacity: appear.interpolate({
                inputRange: [0, 1],
                outputRange: [0, 1],
                extrapolate: 'clamp'
              }),
              // Grows out of the button it hangs from rather than from its own middle.
              transformOrigin: 'top' in anchor ? 'top right' : 'bottom right',
              transform: [
                {
                  scale: appear.interpolate({
                    inputRange: [0, 1],
                    outputRange: [reducedMotion === true ? 1 : 0.9, 1]
                  })
                }
              ]
            }
          ]}
          accessibilityRole="menu"
        >
          <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
            {shown.map((group, groupIndex) => (
              <View key={groupIndex} style={groupIndex > 0 && styles.groupGap}>
                {group.map((action, index) => {
                  const Icon = action.icon
                  const tint = action.destructive ? colors.statusRed : colors.textPrimary
                  return (
                    <Pressable
                      key={action.id ?? action.label}
                      style={({ pressed }) => [
                        styles.item,
                        index > 0 && styles.itemDivider,
                        pressed && styles.itemPressed,
                        action.disabled && styles.itemDisabled
                      ]}
                      disabled={action.disabled || action.loading}
                      onPress={() => press(action)}
                      accessibilityRole="menuitem"
                      accessibilityLabel={action.label}
                      accessibilityHint={action.hint}
                      accessibilityState={
                        action.checked === undefined ? undefined : { checked: action.checked }
                      }
                    >
                      <View style={styles.labelBlock}>
                        <Text style={[styles.label, { color: tint }]} numberOfLines={1}>
                          {action.label}
                        </Text>
                        {/* No tooltips on a phone: a disabled item says why, a destructive one what it replaces. */}
                        {(action.disabled || action.destructive) && action.hint ? (
                          <Text style={styles.hint} numberOfLines={2}>
                            {action.hint}
                          </Text>
                        ) : null}
                      </View>
                      {action.checked ? (
                        <Check size={17} color={tint} strokeWidth={2.2} />
                      ) : action.renderIcon ? (
                        action.renderIcon()
                      ) : (
                        Icon && <Icon size={17} color={tint} strokeWidth={2} />
                      )}
                    </Pressable>
                  )
                })}
              </View>
            ))}
          </ScrollView>
        </Animated.View>
      ) : null}
    </Modal>
  )
}

const styles = themedStyleSheet(() => ({
  menu: {
    position: 'absolute',
    width: MENU_WIDTH,
    borderRadius: radii.surface,
    overflow: 'hidden',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12
  },
  groupGap: {
    borderTopWidth: 6,
    borderTopColor: colors.bgBase
  },
  item: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg
  },
  itemDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  itemPressed: {
    backgroundColor: colors.translucentFill
  },
  itemDisabled: {
    opacity: 0.4
  },
  labelBlock: {
    flexShrink: 1,
    gap: 2
  },
  label: {
    flexShrink: 1,
    fontSize: 15.5
  },
  hint: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  }
}))
