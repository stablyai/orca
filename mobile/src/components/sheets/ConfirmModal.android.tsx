import { AlertDialog, Host, Text, TextButton } from '@expo/ui/jetpack-compose'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { ConfirmModalProps } from './ConfirmContent'
import { DrawnConfirmModal } from './DrawnConfirmModal'
import { DIALOG_HOST_STYLE, DIALOG_TITLE_STYLE } from './native-dialog-host'

export { ConfirmContent } from './ConfirmContent'
export type { ConfirmModalProps }

/** A Material 3 alert dialog; `media` or `details` keep the drawn sheet. */
export function ConfirmModal(props: ConfirmModalProps) {
  if (props.media || props.details) {
    return <DrawnConfirmModal {...props} />
  }
  return <ConfirmAlertDialog {...props} />
}

function ConfirmAlertDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  onCancelPress,
  onCancel
}: ConfirmModalProps) {
  const t = useMobileTranslation()
  const scheme = useMobileColorScheme()
  if (!visible) {
    return null
  }
  return (
    <Host matchContents colorScheme={scheme} style={DIALOG_HOST_STYLE}>
      <AlertDialog onDismissRequest={onCancel}>
        <AlertDialog.Title>
          <Text style={DIALOG_TITLE_STYLE}>{title}</Text>
        </AlertDialog.Title>
        {message ? (
          <AlertDialog.Text>
            <Text>{message}</Text>
          </AlertDialog.Text>
        ) : null}
        <AlertDialog.ConfirmButton>
          <TextButton
            onClick={() => {
              onConfirm?.()
              onCancel()
            }}
          >
            <Text color={destructive ? colors.statusRed : undefined}>
              {confirmLabel ?? t('common.confirm', 'Confirm')}
            </Text>
          </TextButton>
        </AlertDialog.ConfirmButton>
        {cancelLabel === null ? null : (
          <AlertDialog.DismissButton>
            <TextButton
              onClick={() => {
                onCancelPress?.()
                onCancel()
              }}
            >
              <Text>{cancelLabel ?? t('common.cancel', 'Cancel')}</Text>
            </TextButton>
          </AlertDialog.DismissButton>
        )}
      </AlertDialog>
    </Host>
  )
}
