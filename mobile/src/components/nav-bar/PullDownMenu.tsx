import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions
} from 'react-native'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { ActionSheetAction } from '../ActionSheetModal'

const MENU_WIDTH = 252
const ANCHOR_GAP = 6
const EDGE_INSET = 8

type Anchor = { top: number; right: number }

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
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const pendingRef = useRef<(() => void) | null>(null)
  const appear = useRef(new Animated.Value(0)).current

  useLayoutEffect(() => {
    if (!visible) {
      setAnchor(null)
      return
    }
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({
        top: y + height + ANCHOR_GAP,
        right: Math.max(EDGE_INSET, window.width - (x + width))
      })
    })
  }, [anchorRef, visible, window.width])

  useEffect(() => {
    if (anchor === null) {
      return
    }
    appear.setValue(0)
    Animated.timing(appear, { toValue: 1, duration: 160, useNativeDriver: true }).start()
  }, [anchor, appear])

  // An action that opens its own sheet runs once the menu's modal is gone; iOS can't present over it.
  useEffect(() => {
    if (visible || !pendingRef.current) {
      return
    }
    const run = pendingRef.current
    pendingRef.current = null
    const frame = requestAnimationFrame(run)
    return () => cancelAnimationFrame(frame)
  }, [visible])

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

  const shown = groups.map((group) => group.filter(Boolean)).filter((group) => group.length > 0)
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel={t('components.pullDownMenu.close', 'Close menu')}
      />
      {anchor ? (
        <Animated.View
          style={[
            styles.menu,
            { top: anchor.top, right: anchor.right },
            {
              opacity: appear,
              transform: [
                { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) },
                { scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }
              ]
            }
          ]}
          accessibilityRole="menu"
        >
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
                  >
                    <Text style={[styles.label, { color: tint }]} numberOfLines={1}>
                      {action.label}
                    </Text>
                    {action.renderIcon
                      ? action.renderIcon()
                      : Icon && <Icon size={17} color={tint} strokeWidth={2} />}
                  </Pressable>
                )
              })}
            </View>
          ))}
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
    backgroundColor: colors.bgPanel
  },
  itemDisabled: {
    opacity: 0.4
  },
  label: {
    flexShrink: 1,
    fontSize: 15.5
  }
}))
