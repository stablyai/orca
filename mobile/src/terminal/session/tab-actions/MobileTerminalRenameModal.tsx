import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { TextInputSheetContent } from '../../../components/TextInputModal'
import { useDraftRenameSheet } from '../../../components/use-draft-rename-sheet'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useHostDisplay } from '../../../host-descriptors/use-host-display'
import { useHostProfile } from '../../../host-catalog/use-host-profile'
import type { MobileSessionController } from '../../../session/use-mobile-session-controller'

export function MobileTerminalRenameModal({
  controller
}: {
  controller: Pick<
    MobileSessionController,
    'hostId' | 'renameTarget' | 'setRenameTarget' | 'handleRenameTerminal' | 'terminalRenameWrite'
  >
}) {
  const t = useMobileTranslation()
  const { hostId, renameTarget, setRenameTarget, handleRenameTerminal, terminalRenameWrite } =
    controller
  const sheet = useDraftRenameSheet({
    draftKey: renameTarget ? `terminal-rename:${hostId}:${renameTarget.handle}` : null,
    currentName: renameTarget?.title ?? '',
    blockedOffline: terminalRenameWrite.blockedOffline,
    hostName: useHostDisplay(useHostProfile(hostId)).title,
    failureMessage: (reason) =>
      t('session.sheets.renameTerminalFailed', "Couldn't rename the terminal. {{reason}}", {
        reason
      }),
    // Closes the sheet itself once the desktop accepts.
    rename: handleRenameTerminal
  })

  return (
    <BottomDrawer visible={renameTarget != null} onClose={() => setRenameTarget(null)}>
      <TextInputSheetContent
        title={t('session.sheets.renameTerminal', 'Rename Terminal')}
        placeholder={t('session.sheets.terminalName', 'Terminal name')}
        {...sheet.sheetProps}
        onSubmit={(title) => void sheet.submit(title)}
        onCancel={() => setRenameTarget(null)}
      />
    </BottomDrawer>
  )
}
