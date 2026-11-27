import { DocumentFloatingBar } from '../../drafts/DocumentEditDraftOfferBar'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { useFilePreviewFloatingBarBottom } from './MobileFilePreviewEditDraft'
import type { MobileFilePreviewConflict } from './use-mobile-file-preview-save'

/** A save the host refused because disk moved on: take disk's version, or write the draft over it. */
export function MobileFilePreviewConflictBar(props: {
  conflict: MobileFilePreviewConflict
  saving: boolean
  onReload: () => void
  onOverwrite: () => void
}) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  return (
    <DocumentFloatingBar
      bottom={useFilePreviewFloatingBarBottom()}
      status={
        props.conflict === 'missing'
          ? t('files.filePreviewScreen.deletedOnDesktop', 'Deleted on desktop')
          : t('files.filePreviewScreen.changedOnDesktop', 'Changed on desktop')
      }
      statusColor={colors.statusAmber}
      quiet={{
        label: t('files.filePreviewScreen.reload', 'Reload'),
        onPress: props.onReload,
        disabled: props.saving
      }}
      primary={{
        label: t('files.filePreviewScreen.overwrite', 'Overwrite'),
        onPress: props.onOverwrite,
        disabled: props.saving
      }}
    />
  )
}
