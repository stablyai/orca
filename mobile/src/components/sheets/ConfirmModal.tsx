import type { ReactNode } from 'react'
import { View, Text, Pressable } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, spacing, radii, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { BottomDrawer } from '../bottom-drawer/BottomDrawer'

type ContentProps = {
  /** Above a centred title, e.g. a security confirm's shield tile. */
  media?: ReactNode
  title: string
  message?: string
  /** Under the message, e.g. what a security confirm grants, one row each. */
  details?: ReactNode
  confirmLabel?: string
  /** `null` drops the Cancel button, for a notice that only needs acknowledging. */
  cancelLabel?: string | null
  destructive?: boolean
  /** Optional for a notice, whose one button only dismisses. */
  onConfirm?: () => void
  /** The Cancel button's own answer, e.g. Decline; closing any other way calls only `onCancel`. */
  onCancelPress?: () => void
  onCancel: () => void
}

type Props = ContentProps & {
  visible: boolean
  /** False when only an answer may close it, e.g. a page blocked until it gets one. */
  dismissible?: boolean
}

export function ConfirmModal({ visible, dismissible, ...content }: Props) {
  return (
    <BottomDrawer visible={visible} onClose={content.onCancel} dismissible={dismissible}>
      <ConfirmContent {...content} />
    </BottomDrawer>
  )
}

export function ConfirmContent({
  media,
  title,
  message,
  details,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  onCancelPress,
  onCancel
}: ContentProps) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <>
      <View style={styles.content}>
        {media ? <View style={styles.media}>{media}</View> : null}
        <Text style={[styles.title, media ? styles.centred : null]}>{title}</Text>
        {message ? (
          <Text style={[styles.message, media ? styles.centred : null]}>{message}</Text>
        ) : null}
        {details}
      </View>
      <View style={styles.buttons}>
        {cancelLabel === null ? null : (
          <Pressable
            style={({ pressed }) => [styles.button, styles.cancelButton, pressed && styles.pressed]}
            onPress={() => {
              onCancelPress?.()
              onCancel()
            }}
          >
            <Text style={styles.cancelText}>{cancelLabel ?? t('common.cancel', 'Cancel')}</Text>
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
            {confirmLabel ?? t('common.confirm', 'Confirm')}
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
  media: { alignItems: 'center', marginBottom: spacing.md },
  centred: { textAlign: 'center' },
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
    borderRadius: radii.control,
    alignItems: 'center'
  },
  cancelButton: {
    backgroundColor: colors.sheetGroup
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
  // The desktop's destructive-foreground: dark ink on dark's light red, white on light's.
  destructiveText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.onStatusRed
  }
}))
