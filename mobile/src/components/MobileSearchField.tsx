import { useEffect, useRef } from 'react'
import {
  InteractionManager,
  Pressable,
  View,
  type StyleProp,
  type TextInput,
  type TextInputProps,
  type ViewStyle
} from 'react-native'
import { Search, X } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { TextField } from './composer-input/TextField'

// Delay focus until opening chrome settles; native autoFocus alone often shows caret without iOS/Android keyboard.
const SEARCH_AUTO_FOCUS_DELAY_MS = 120

type MobileSearchFieldProps = {
  value: string
  onChangeText: (text: string) => void
  placeholder: string
  onClear?: () => void
  /** Override clear-button visibility (default: value is non-empty). */
  showClear?: boolean
  clearAccessibilityLabel?: string
  autoFocus?: boolean
  /** Re-run delayed focus when this identity changes (e.g. each time search opens). */
  focusKey?: unknown
  returnKeyType?: TextInputProps['returnKeyType']
  onSubmitEditing?: TextInputProps['onSubmitEditing']
  onBlur?: TextInputProps['onBlur']
  onFocus?: TextInputProps['onFocus']
  editable?: boolean
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

export function MobileSearchField({
  value,
  onChangeText,
  placeholder,
  onClear,
  showClear,
  clearAccessibilityLabel,
  autoFocus = false,
  focusKey,
  returnKeyType = 'search',
  onSubmitEditing,
  onBlur,
  onFocus,
  editable = true,
  accessibilityLabel,
  style
}: MobileSearchFieldProps) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const inputRef = useRef<TextInput>(null)
  const clearVisible = showClear ?? value.length > 0

  useEffect(() => {
    if (!autoFocus || !editable) {
      return
    }

    let timeout: ReturnType<typeof setTimeout> | undefined
    // Wait for press/layout completion before focusing so soft keyboard appears.
    const task = InteractionManager.runAfterInteractions(() => {
      timeout = setTimeout(() => {
        inputRef.current?.focus()
      }, SEARCH_AUTO_FOCUS_DELAY_MS)
    })

    return () => {
      task.cancel()
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }, [autoFocus, editable, focusKey])

  function handleClear() {
    if (onClear) {
      onClear()
    } else {
      onChangeText('')
    }
    // Clear chip steals focus; restore it so typing can continue without another tap.
    requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
  }

  return (
    <TextField
      inputRef={inputRef}
      leading={<Search size={16} color={colors.textMuted} />}
      trailing={
        clearVisible ? (
          <Pressable
            onPress={handleClear}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={
              clearAccessibilityLabel ?? t('components.searchField.clearSearch', 'Clear search')
            }
            style={({ pressed }) => [styles.clearButton, pressed && styles.clearButtonPressed]}
          >
            {/* Use chip and large hit target: bare 14px X looked decorative and was hard to tap. */}
            <View style={styles.clearChip}>
              <X size={12} color={colors.surfaceBright} strokeWidth={2.6} />
            </View>
          </Pressable>
        ) : undefined
      }
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      // Still request native auto-focus; the delayed ref focus is the reliable path.
      autoFocus={autoFocus}
      showSoftInputOnFocus
      editable={editable}
      returnKeyType={returnKeyType}
      onSubmitEditing={onSubmitEditing}
      onBlur={onBlur}
      onFocus={onFocus}
      style={style}
      clearButtonMode="never"
      accessibilityLabel={accessibilityLabel ?? placeholder}
    />
  )
}

const styles = themedStyleSheet(() => ({
  clearButton: {
    // Pull the 36pt target into the field's end padding so the chip sits near the edge.
    marginRight: -spacing.sm,
    minWidth: 36,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center'
  },
  clearButtonPressed: {
    opacity: 0.7
  },
  clearChip: {
    width: 24,
    height: 24,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    // A solid textMuted chip reads as a control; borderSubtle looked decorative.
    backgroundColor: colors.textMuted
  }
}))
