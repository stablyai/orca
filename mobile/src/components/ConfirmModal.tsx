import { View, Text, Pressable } from 'react-native'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { BottomDrawer } from './BottomDrawer'

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
}

type Props = ContentProps & { visible: boolean }

export function ConfirmModal({ visible, ...content }: Props) {
  return (
    <BottomDrawer visible={visible} onClose={content.onCancel}>
      <ConfirmContent {...content} />
    </BottomDrawer>
  )
}

export function ConfirmContent({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel
}: ContentProps) {
  useMobileColorScheme()
  return (
    <>
      <View style={styles.content}>
        <Text style={styles.title}>{title}</Text>
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>
      <View style={styles.buttons}>
        {cancelLabel === null ? null : (
          <Pressable
            style={({ pressed }) => [styles.button, styles.cancelButton, pressed && styles.pressed]}
            onPress={onCancel}
          >
            <Text style={styles.cancelText}>{cancelLabel}</Text>
          </Pressable>
        )}
        <Pressable
          style={({ pressed }) => [
            styles.button,
            destructive ? styles.destructiveButton : styles.confirmButton,
            pressed && styles.pressed
          ]}
          onPress={() => {
            onConfirm?.()
            onCancel()
          }}
        >
          <Text style={destructive ? styles.destructiveText : styles.confirmText}>
            {confirmLabel}
          </Text>
        </Pressable>
      </View>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  content: {
    paddingBottom: spacing.lg
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary
  },
  message: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    lineHeight: 20
  },
  buttons: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  button: {
    flex: 1,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button,
    alignItems: 'center'
  },
  cancelButton: {
    backgroundColor: colors.bgPanel
  },
  confirmButton: {
    backgroundColor: colors.textPrimary
  },
  destructiveButton: {
    backgroundColor: colors.statusRed
  },
  pressed: {
    opacity: 0.7
  },
  cancelText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textSecondary
  },
  confirmText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.bgBase
  },
  destructiveText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: '#fff'
  }
}))
