import { ConfirmModal } from '../components/ConfirmModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export function MobileFilePreviewDiscardModal(props: {
  visible: boolean
  saving: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const t = useMobileTranslation()
  return (
    <ConfirmModal
      visible={props.visible}
      title={t('files.filePreviewScreen.discardTitle', 'Discard changes?')}
      message={
        props.saving
          ? t(
              'files.filePreviewScreen.discardMessageSaving',
              'The save in progress may not finish. Unsaved edits will be lost.'
            )
          : t('files.filePreviewScreen.discardMessage', 'Unsaved edits will be lost.')
      }
      confirmLabel={t('files.filePreviewScreen.discard', 'Discard')}
      cancelLabel={t('files.filePreviewScreen.stay', 'Stay')}
      destructive
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  )
}
