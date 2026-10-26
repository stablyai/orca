import { useEffect, useRef, useState } from 'react'
import {
  InteractionManager,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps
} from 'react-native'
import { Search, X } from 'lucide-react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'

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
  editable?: boolean
  accessibilityLabel?: string
}

// Raised search field stays visibly tappable above list/panel canvas.
export function MobileSearchField({
  value,
  onChangeText,
  placeholder,
  onClear,
  showClear,
  clearAccessibilityLabel = 'Clear search',
  autoFocus = false,
  focusKey,
  returnKeyType = 'search',
  onSubmitEditing,
  onBlur,
  editable = true,
  accessibilityLabel
}: MobileSearchFieldProps) {
  const inputRef = useRef<TextInput>(null)
  const [focused, setFocused] = useState(false)
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
    <View style={[styles.shell, focused && styles.shellFocused, !editable && styles.shellDisabled]}>
      <Search
        size={15}
        color={focused ? colors.textPrimary : colors.textSecondary}
        strokeWidth={2.2}
      />
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        // textSecondary keeps hint readable on bgRaised; textMuted looked empty.
        placeholderTextColor={colors.textSecondary}
        autoCapitalize="none"
        autoCorrect={false}
        // Still request native auto-focus; the delayed ref focus is the reliable path.
        autoFocus={autoFocus}
        showSoftInputOnFocus
        editable={editable}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          setFocused(false)
          onBlur?.(event)
        }}
        clearButtonMode="never"
        accessibilityLabel={accessibilityLabel ?? placeholder}
        selectionColor={colors.accentBlue}
      />
      {clearVisible ? (
        <Pressable
          onPress={handleClear}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={clearAccessibilityLabel}
          style={({ pressed }) => [styles.clearButton, pressed && styles.clearButtonPressed]}
        >
          {/* Use chip and large hit target: bare 14px X looked decorative and was hard to tap. */}
          <View style={styles.clearChip}>
            <X size={12} color={colors.surfaceBright} strokeWidth={2.6} />
          </View>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  shell: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    // Keep search visually distinct from surrounding panels.
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm : spacing.xs + 2
  },
  shellFocused: {
    // Monochrome focus cue reserves blue for state/selection; textMuted remains visible on bgRaised.
    borderColor: colors.textMuted
  },
  shellDisabled: {
    opacity: 0.55
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    margin: 0,
    color: colors.textPrimary,
    fontSize: TEXT_INPUT_FONT_SIZE,
    // Remove Android TextInput vertical padding to align icon/clear chip.
    includeFontPadding: false,
    textAlignVertical: 'center'
  },
  clearButton: {
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
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    // textMuted makes solid clear chip on bgRaised; borderSubtle looked decorative.
    backgroundColor: colors.textMuted
  }
})
