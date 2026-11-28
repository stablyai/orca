import { useContext, useState } from 'react'
import { ConfirmModal } from '../../components/sheets/ConfirmModal'
import { DocumentFloatingBar } from '../../drafts/DocumentEditDraftOfferBar'
import { useHostProfile } from '../../host-catalog/use-host-profile'
import { useHostDisplay } from '../../host-descriptors/use-host-display'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { WorkspaceServerContext } from '../../worktree/execution-hosts/workspace-server-context'
import { useFilePreviewFloatingBarBottom } from './MobileFilePreviewEditDraft'
import type { MobileFilePreviewConflict } from './use-mobile-file-preview-save'

/** A save the host refused because disk moved on: take disk's version, or write the draft over it. */
export function MobileFilePreviewConflictBar(props: {
  hostId: string
  conflict: MobileFilePreviewConflict
  saving: boolean
  onReload: () => void
  onOverwrite: () => void
}) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const computer = useConflictComputerName(props.hostId)
  const [confirmingReload, setConfirmingReload] = useState(false)
  const status =
    props.conflict === 'missing'
      ? computer
        ? t('files.filePreviewScreen.deletedOnComputer', 'Deleted on {{computer}}', { computer })
        : t('files.filePreviewScreen.deletedSinceOpened', 'Deleted since you opened it')
      : computer
        ? t('files.filePreviewScreen.changedOnComputer', 'Changed on {{computer}}', { computer })
        : t('files.filePreviewScreen.changedSinceOpened', 'Changed since you opened it')
  return (
    <>
      <DocumentFloatingBar
        bottom={useFilePreviewFloatingBarBottom()}
        status={status}
        statusColor={colors.statusAmber}
        quiet={{
          label: t('files.filePreviewScreen.reload', 'Reload'),
          onPress: () => setConfirmingReload(true),
          disabled: props.saving
        }}
        primary={{
          label: t('files.filePreviewScreen.overwrite', 'Overwrite'),
          onPress: props.onOverwrite,
          disabled: props.saving
        }}
      />
      {/* Why ask: Reload throws away the phone's draft for what disk holds now. */}
      <ConfirmModal
        visible={confirmingReload}
        title={t(
          'files.filePreviewScreen.reloadConfirmTitle',
          'Discard your changes and load the latest?'
        )}
        confirmLabel={t('files.filePreviewScreen.discard', 'Discard')}
        cancelLabel={t('common.cancel', 'Cancel')}
        destructive
        onConfirm={() => {
          setConfirmingReload(false)
          props.onReload()
        }}
        onCancel={() => setConfirmingReload(false)}
      />
    </>
  )
}

/** The computer whose disk moved on: a server workspace's server, else the paired host; null when unnamed. */
function useConflictComputerName(hostId: string): string | null {
  const serverName = useContext(WorkspaceServerContext)?.name?.trim()
  const profile = useHostProfile(hostId)
  const display = useHostDisplay(profile)
  if (serverName) {
    return serverName
  }
  return profile ? display.title : null
}
