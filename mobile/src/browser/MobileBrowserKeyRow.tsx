import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

const BROWSER_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape'] as const

type Props = {
  disabled: boolean
  onKeypress: (key: string) => void
}

export function MobileBrowserKeyRow({ disabled, onKeypress }: Props): React.JSX.Element {
  return (
    <View style={styles.keyRow}>
      {BROWSER_KEYS.map((key) => (
        <Pressable
          key={key}
          style={({ pressed }) => [
            styles.keyButton,
            pressed && styles.keyButtonPressed,
            disabled && styles.disabled
          ]}
          disabled={disabled}
          onPress={() => onKeypress(key)}
        >
          <Text style={[styles.keyButtonText, disabled && styles.disabledText]}>
            {key === 'Backspace' ? '⌫' : key === 'Escape' ? 'Esc' : key}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  keyRow: {
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
  keyButtonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: typography.monoFamily
  },
  disabled: {
    opacity: 0.35
  },
  disabledText: {
    color: colors.textMuted
  }
})
