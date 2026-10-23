import { ActivityIndicator, View, Text, Pressable, StyleSheet } from 'react-native'
import { colors, motion, radii, spacing, textStyles } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import { Button } from './ui/Button'
import { pressTransition } from './ui/transition-styles'

type ContentProps = {
  title: string
  message?: string
  confirmLabel?: string
  /** `null` drops the Cancel button, for a notice that only needs acknowledging. */
  cancelLabel?: string | null
  destructive?: boolean
  /** Optional for a notice, whose one button only dismisses. */
  onConfirm?: () => void
  onCancel: () => void
  /** Spins on the confirm and holds both buttons, for a caller that keeps the sheet up while it works. */
  busy?: boolean
  /** `false` keeps the sheet open after confirming, so the caller can show `busy` and close it itself. */
  dismissOnConfirm?: boolean
}

type Props = ContentProps & { visible: boolean }

export function ConfirmModal({ visible, ...content }: Props) {
  return (
    <BottomDrawer visible={visible} onClose={content.onCancel}>
      <ConfirmContent {...content} />
    </BottomDrawer>
  )
}

/** Title, one sentence, then the confirm on top and a plain Cancel under it, both full width. */
export function ConfirmContent({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
  busy = false,
  dismissOnConfirm = true
}: ContentProps) {
  const confirm = () => {
    onConfirm?.()
    if (dismissOnConfirm) {
      onCancel()
    }
  }
  return (
    <View style={styles.root}>
      <View style={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>
      <View style={styles.buttons}>
        {destructive ? (
          <DestructiveConfirm label={confirmLabel} busy={busy} onPress={confirm} />
        ) : (
          <Button label={confirmLabel} variant="primary" block busy={busy} onPress={confirm} />
        )}
        {cancelLabel === null ? null : (
          <Button label={cancelLabel} variant="plain" block disabled={busy} onPress={onCancel} />
        )}
      </View>
    </View>
  )
}

// Why: the only red fill in the app; `Button`'s destructive variant is red text on a soft fill.
function DestructiveConfirm({
  label,
  busy,
  onPress
}: {
  label: string
  busy: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy, busy }}
      style={styles.touch}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.destructive,
            pressed && styles.destructivePressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          {busy ? <ActivityIndicator size="small" color={colors.onDanger} /> : null}
          <Text style={styles.destructiveLabel} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: spacing.xs, paddingTop: spacing.xs },
  content: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl
  },
  title: { ...textStyles.headline, color: colors.textPrimary, textAlign: 'center' },
  message: { ...textStyles.callout, color: colors.textSecondary, textAlign: 'center' },
  buttons: { gap: spacing.xs },
  touch: { minHeight: 50, alignSelf: 'stretch' },
  destructive: {
    height: 50,
    borderRadius: radii.pill,
    paddingHorizontal: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    // Why: `danger` is tuned for red text on dark; white on it is under 3:1, on statusRed nearly 4.
    backgroundColor: colors.statusRed
  },
  destructivePressed: { opacity: 0.82, transform: [{ scale: motion.pressedScale }] },
  destructiveLabel: { ...textStyles.body, fontWeight: '600', color: colors.onDanger }
})
