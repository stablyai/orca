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
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

// Why: toolbar/list chrome paints and settles after the open tap; native
// autoFocus alone often fails to raise the soft keyboard on iOS/Android.
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

/**
 * Raised search field used on list screens. Sits above the base/panel canvas
 * so it reads as a tappable control instead of chrome that blends into the list.
 */
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
    // Why: wait for the open-press interaction + layout to finish, then focus
    // so the soft keyboard actually appears (not just a caret with no IME).
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
    // Why: pressing the clear chip steals focus and drops the keyboard;
    // re-focus so the user can keep typing without tapping the field again.
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
        // Why: textSecondary keeps the hint readable on bgRaised; textMuted
        // disappears against the raised shell and makes the field look empty.
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
          {/* Why: chip + larger hit target — a bare 14px X was hard to tap and
              read as decoration rather than a clear control. */}
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
    // Why: bgRaised lifts the field off bgBase/bgPanel so search is an obvious
    // control, matching TextInputModal / MobilePrBasePicker input shells.
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm : spacing.xs + 2
  },
  shellFocused: {
    // Why: monochrome focus cue without burning the blue accent token
    // (reserved for state/selection). textMuted reads clearly on bgRaised.
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
    fontSize: typography.bodySize,
    // Why: Android TextInput draws extra vertical padding that misaligns the
    // icon/clear chip unless we zero it out.
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
    // Why: textMuted reads as a solid chip on bgRaised; borderSubtle was nearly
    // invisible and made the clear control feel like decorative chrome.
    backgroundColor: colors.textMuted
  }
})
