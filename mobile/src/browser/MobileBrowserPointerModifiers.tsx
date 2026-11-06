import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export type BrowserPointerModifier = 'cmd' | 'ctrl' | 'alt' | 'shift'

const BROWSER_POINTER_MODIFIERS: { id: BrowserPointerModifier; label: string }[] = [
  { id: 'cmd', label: 'Cmd' },
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt' },
  { id: 'shift', label: 'Shift' }
]

type Props = {
  disabled: boolean
  selectedModifiers: BrowserPointerModifier[]
  onToggle: (modifier: BrowserPointerModifier) => void
}

export function MobileBrowserPointerModifiers({
  disabled,
  selectedModifiers,
  onToggle
}: Props): React.JSX.Element {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.modifierRow}>
      {BROWSER_POINTER_MODIFIERS.map((modifier) => {
        const selected = selectedModifiers.includes(modifier.id)
        return (
          <Pressable
            key={modifier.id}
            style={({ pressed }) => [
              styles.keyButton,
              selected && styles.keyButtonSelected,
              pressed && !selected && styles.keyButtonPressed,
              disabled && styles.disabled
            ]}
            disabled={disabled}
            onPress={() => onToggle(modifier.id)}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={t(
              'browser.pointerModifiers.clickModifier',
              '{{key}} click modifier',
              {
                key: modifier.label
              }
            )}
          >
            <Text
              style={[
                styles.keyButtonText,
                selected && styles.keyButtonTextSelected,
                disabled && styles.disabledText
              ]}
            >
              {modifier.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  modifierRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs
  },
  keyButton: {
    minHeight: 30,
    minWidth: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.sm
  },
  keyButtonPressed: {
    backgroundColor: colors.borderSubtle
  },
  keyButtonSelected: {
    backgroundColor: colors.textPrimary
  },
  keyButtonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: typography.monoFamily
  },
  keyButtonTextSelected: {
    color: colors.bgBase
  },
  disabled: {
    opacity: 0.35
  },
  disabledText: {
    color: colors.textMuted
  }
}))
