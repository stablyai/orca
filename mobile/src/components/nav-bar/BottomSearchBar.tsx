import { useEffect, useState, type ComponentType } from 'react'
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { X } from 'lucide-react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useKeyboardOcclusion } from '../../platform/keyboard-occlusion'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileSearchField } from '../MobileSearchField'

const FADE_ID = 'bottom-search-bar-fade'
const BUTTON_SIZE = 44

type IconProps = { size?: number; color?: string; strokeWidth?: number }

type BarButton = {
  icon: ComponentType<IconProps>
  accessibilityLabel: string
  onPress: () => void
  disabled?: boolean
  /** A filter is applied: the button lights up and shows the count. */
  badge?: number
}

type BottomSearchBarProps = {
  value: string
  onChangeText: (text: string) => void
  placeholder: string
  /** Bottom safe-area inset of the screen. */
  bottomInset: number
  /** Usually filters or view options. Hidden while searching. */
  leading?: BarButton
  /** The screen's primary action, e.g. New workspace. Gives way to Close while searching. */
  primary?: BarButton
  /** How much of the screen's bottom the bar and keyboard cover; lists and empty states pad by it. */
  onCoveredHeightChange?: (height: number) => void
  /** For screens that search on Return rather than as you type. */
  onSubmitEditing?: () => void
  onBlur?: () => void
  /** Close's way out of search, e.g. back to a preset query; defaults to emptying the field. */
  onClear?: () => void
  /** Whether the field holds a search; defaults to non-empty text. False for a seeded default query. */
  hasSearch?: boolean
  editable?: boolean
  accessibilityLabel?: string
}

// Search lives under the thumb on every list screen: a wide field, with a filter button and the primary action beside it.
export function BottomSearchBar({
  value,
  onChangeText,
  placeholder,
  bottomInset,
  leading,
  primary,
  onCoveredHeightChange,
  onSubmitEditing,
  onBlur,
  onClear,
  hasSearch,
  editable,
  accessibilityLabel
}: BottomSearchBarProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const keyboardHeight = useKeyboardOcclusion()
  const keyboardUp = keyboardHeight > 0
  const [focused, setFocused] = useState(false)
  const [barHeight, setBarHeight] = useState(0)
  const coveredHeight = barHeight + keyboardHeight
  useEffect(() => {
    onCoveredHeightChange?.(coveredHeight)
  }, [coveredHeight, onCoveredHeightChange])
  // Close stays until the keyboard is down: iOS's late click at the tapped spot would otherwise hit the primary action that replaced it.
  const searching = focused || keyboardUp || (hasSearch ?? value.trim() !== '')

  const closeSearch = () => {
    if (onClear) {
      onClear()
    } else {
      onChangeText('')
    }
    setFocused(false)
    Keyboard.dismiss()
  }

  return (
    <View
      style={[
        styles.bar,
        keyboardUp
          ? { bottom: keyboardHeight, paddingBottom: spacing.sm }
          : { paddingBottom: Math.max(bottomInset, spacing.lg) }
      ]}
      onLayout={(event) => setBarHeight(event.nativeEvent.layout.height)}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id={FADE_ID} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.bgBase} stopOpacity={0} />
              <Stop offset="0.45" stopColor={colors.bgBase} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill={`url(#${FADE_ID})`} />
        </Svg>
      </View>
      <View style={styles.row}>
        {leading && !searching ? <RoundButton button={leading} /> : null}
        <View style={styles.search}>
          <MobileSearchField
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false)
              onBlur?.()
            }}
            onSubmitEditing={onSubmitEditing}
            // Close beside the field is the one way out; a second X inside it read as the same button.
            showClear={false}
            editable={editable}
            accessibilityLabel={accessibilityLabel}
            style={styles.field}
          />
        </View>
        {searching ? (
          <RoundButton
            button={{
              icon: X,
              accessibilityLabel: t('components.bottomSearchBar.closeSearch', 'Close search'),
              onPress: closeSearch
            }}
          />
        ) : primary ? (
          <RoundButton button={primary} emphasis />
        ) : null}
      </View>
    </View>
  )
}

function RoundButton({ button, emphasis = false }: { button: BarButton; emphasis?: boolean }) {
  const { icon: Icon, badge = 0 } = button
  const lit = badge > 0
  return (
    <Pressable
      onPress={button.onPress}
      disabled={button.disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={button.accessibilityLabel}
      accessibilityState={{ disabled: button.disabled === true, selected: lit }}
      style={({ pressed }) => [
        styles.button,
        emphasis && styles.buttonEmphasis,
        lit && styles.buttonLit,
        pressed && styles.pressed,
        button.disabled && styles.disabled
      ]}
    >
      <Icon size={20} color={emphasis ? colors.bgBase : colors.textPrimary} strokeWidth={2.2} />
      {lit ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 36,
    paddingHorizontal: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  search: {
    flex: 1,
    minWidth: 0
  },
  field: {
    minHeight: BUTTON_SIZE,
    borderRadius: radii.pill,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6
  },
  buttonEmphasis: {
    backgroundColor: colors.surfaceBright,
    borderColor: 'transparent'
  },
  buttonLit: {
    borderColor: colors.textSecondary
  },
  pressed: {
    opacity: 0.75
  },
  disabled: {
    opacity: 0.4
  },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentBlue
  },
  badgeText: {
    color: colors.onAccent,
    fontSize: 11,
    fontWeight: '700'
  }
}))
