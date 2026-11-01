import { TextInputModal } from '../components/TextInputModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileTerminalRenameModal({
  controller
}: {
  controller: Pick<
    MobileSessionController,
    'renameTarget' | 'setRenameTarget' | 'handleRenameTerminal'
  >
}) {
  const t = useMobileTranslation()
  const { renameTarget, setRenameTarget, handleRenameTerminal } = controller
  return (
    <TextInputModal
      visible={renameTarget != null}
      title={t('session.sheets.renameTerminal', 'Rename Terminal')}
      defaultValue={renameTarget?.title ?? ''}
      placeholder={t('session.sheets.terminalName', 'Terminal name')}
      onSubmit={(value) => void handleRenameTerminal(value)}
      onCancel={() => setRenameTarget(null)}
    />
  )
}
