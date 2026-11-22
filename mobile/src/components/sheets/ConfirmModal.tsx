import { useShellDialog } from '../../platform/page-dialogs/use-shell-dialog'
import { ConfirmContent, type ConfirmModalProps } from './ConfirmContent'
import { DrawnConfirmModal } from './DrawnConfirmModal'

export { ConfirmContent }
export type { ConfirmModalProps }

export function ConfirmModal({ visible, ...content }: ConfirmModalProps) {
  // `media` and `details` are views the shell's alert can't hold, so those stay drawn.
  const native = useShellDialog({
    visible,
    request:
      content.media || content.details
        ? null
        : {
            action: 'confirm',
            title: content.title,
            message: content.message,
            confirmLabel: content.confirmLabel,
            cancelLabel: content.cancelLabel,
            destructive: content.destructive === true
          },
    onAnswer: ({ outcome }) => {
      if (outcome === 'confirm') {
        content.onConfirm?.()
      } else if (outcome === 'cancel') {
        content.onCancelPress?.()
      }
      content.onCancel()
    }
  })
  if (native) {
    return null
  }
  return <DrawnConfirmModal visible={visible} {...content} />
}
