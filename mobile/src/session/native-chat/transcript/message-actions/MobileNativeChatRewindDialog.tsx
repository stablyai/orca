import { ConfirmModal } from '../../../../components/ConfirmModal'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import type { MobileNativeChatRewindDialogState } from './use-mobile-native-chat-rewind-dialog'

/** Desktop's Rewind confirmation, or why Rewind can't run right now. */
export function MobileNativeChatRewindDialog({
  dialog,
  onClose
}: {
  dialog: MobileNativeChatRewindDialogState
  onClose: (confirmed: boolean) => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  return dialog.kind === 'notice' ? (
    <ConfirmModal
      visible
      title={t('chat.messageActionsSheet.rewind', 'Rewind to here')}
      message={dialog.message}
      confirmLabel={t('common.ok', 'OK')}
      cancelLabel={null}
      onConfirm={() => onClose(false)}
      onCancel={() => onClose(false)}
    />
  ) : (
    <ConfirmModal
      visible
      destructive
      title={t('chat.rewind.title', 'Rewind to here?')}
      message={t(
        'chat.rewind.confirmation',
        'Discard this message and everything after it? The message returns to the composer so you can edit and resend it. File changes on disk are kept.'
      )}
      confirmLabel={t('chat.rewind.confirm', 'Rewind')}
      onConfirm={() => onClose(true)}
      onCancel={() => onClose(false)}
    />
  )
}
