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
import { colors, floatingSurface, radii, spacing, textStyles } from '../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'

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
  onFocus?: TextInputProps['onFocus']
  editable?: boolean
  accessibilityLabel?: string
  /** Opaque, with an edge and shadow, for a field floating over scrolling content. */
  floating?: boolean
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
  onFocus,
  editable = true,
  accessibilityLabel,
  floating = false
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
    <View
      style={[
        styles.shell,
        floating && floatingSurface,
        focused && styles.shellFocused,
        !editable && styles.shellDisabled
      ]}
    >
      <Search
        size={16}
        color={focused ? colors.textSecondary : colors.textMuted}
        strokeWidth={2.2}
      />
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        // Still request native auto-focus; the delayed ref focus is the reliable path.
        autoFocus={autoFocus}
        showSoftInputOnFocus
        editable={editable}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        onFocus={(event) => {
          setFocused(true)
          onFocus?.(event)
        }}
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
            <X size={11} color={colors.bgBase} strokeWidth={3} />
          </View>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  shell: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.fill,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: radii.pill,
    paddingLeft: 14,
    paddingRight: 4,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm : spacing.xs + 2
  },
  shellFocused: {
    // A brighter edge, not the blue accent: blue is kept for selection and links.
    borderColor: colors.fieldBorderFocused
  },
  shellDisabled: {
    opacity: 0.4
  },
  input: {
    ...textStyles.body,
    flex: 1,
    minWidth: 0,
    padding: 0,
    margin: 0,
    color: colors.textPrimary,
    fontSize: TEXT_INPUT_FONT_SIZE,
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
    opacity: 0.6
  },
  clearChip: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.textMuted
  }
})
