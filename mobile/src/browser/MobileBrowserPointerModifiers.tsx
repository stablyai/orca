import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { t } from '@/i18n/mobile-i18n'

export type BrowserPointerModifier = 'cmd' | 'ctrl' | 'alt' | 'shift'

const BROWSER_POINTER_MODIFIERS: { id: BrowserPointerModifier; label: string }[] = [
  { id: 'cmd', label: t('mobileBrowserPointerModifiers.cmd') },
  { id: 'ctrl', label: t('mobileBrowserPointerModifiers.ctrl') },
  { id: 'alt', label: t('mobileBrowserPointerModifiers.alt') },
  { id: 'shift', label: t('mobileBrowserPointerModifiers.shift') }
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
            accessibilityLabel={t('mobileBrowserPointerModifiers.modifier', {
              modifierLabel: modifier.label
            })}
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

const styles = StyleSheet.create({
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
    borderRadius: radii.button,
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
})
