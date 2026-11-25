import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { MobilePendingButton } from '../../components/controls/MobilePendingButton'
import { colors, feedback, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export type MobileMarkdownNoteBarAction = {
  label: string
  onPress: () => void
  disabled?: boolean
  pending?: boolean
}

export type MobileMarkdownNoteBarProps = {
  /** One line about the note, e.g. a save error or "Changed on desktop". */
  reason?: { text: string; color?: string }
  /** The quiet way out at the leading edge, e.g. Discard. */
  quiet?: MobileMarkdownNoteBarAction
  /** The next step at the trailing edge, e.g. Save; secondary for a step that changes nothing. */
  primary?: MobileMarkdownNoteBarAction & { secondary?: boolean }
}

/** The note's next step at its foot, shown while the keyboard is down: Source Control's next-step bar values. */
export function MobileMarkdownNoteBar({ reason, quiet, primary }: MobileMarkdownNoteBarProps) {
  useMobileColorScheme()
  const insets = useSafeAreaInsets()
  const ink = primary?.secondary ? colors.textPrimary : colors.bgBase
  // With no quiet action, the reason takes the leading slot beside the button.
  const inlineReason = reason && !quiet && primary ? reason : null
  return (
    <View style={[styles.bar, { paddingBottom: spacing.md + insets.bottom }]}>
      {reason && !inlineReason ? (
        <Text
          style={[styles.reason, reason.color ? { color: reason.color } : null]}
          numberOfLines={3}
        >
          {reason.text}
        </Text>
      ) : null}
      {quiet || primary ? (
        <View style={styles.row}>
          {inlineReason ? (
            <Text
              style={[
                styles.inlineReason,
                inlineReason.color ? { color: inlineReason.color } : null
              ]}
              numberOfLines={2}
            >
              {inlineReason.text}
            </Text>
          ) : null}
          {quiet ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: quiet.disabled === true }}
              disabled={quiet.disabled}
              onPress={quiet.onPress}
              style={({ pressed }) => [
                styles.quiet,
                pressed && styles.pressed,
                quiet.disabled && styles.disabled
              ]}
            >
              <Text style={styles.quietLabel}>{quiet.label}</Text>
            </Pressable>
          ) : null}
          {inlineReason ? null : <View style={styles.spacer} />}
          {primary ? (
            <MobilePendingButton
              label={primary.label}
              pending={primary.pending}
              disabled={primary.disabled}
              onPress={primary.onPress}
              style={[styles.button, primary.secondary && styles.buttonSecondary]}
              labelStyle={[styles.buttonLabel, { color: ink }]}
              spinnerColor={ink}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgBase
  },
  reason: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    textAlign: 'center'
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  inlineReason: { flex: 1, color: colors.textSecondary, fontSize: typography.bodySize },
  spacer: { flex: 1 },
  // No inset of its own, so the label starts on the note's text edge.
  quiet: {
    minHeight: 48,
    minWidth: 44,
    justifyContent: 'center'
  },
  quietLabel: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  button: {
    minHeight: 48,
    minWidth: 120,
    borderRadius: radii.control,
    backgroundColor: colors.surfaceBright,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg
  },
  buttonSecondary: { backgroundColor: colors.bgRaised },
  buttonLabel: { fontSize: typography.bodySize, fontWeight: '600' },
  pressed: { opacity: feedback.pressedOpacity },
  disabled: { opacity: feedback.disabledOpacity }
}))
