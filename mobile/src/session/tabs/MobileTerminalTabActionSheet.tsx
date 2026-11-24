import { ActionSheetModal } from '../../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { getMobileTerminalActionSheetActions } from '../../terminal/session/tab-actions/mobile-terminal-action-sheet-actions'
import { isTerminalPhoneDisplayMode } from '../../terminal/session/pane-layout/terminal-phone-display-mode'
import { useMobileAllowAutoCloseActions } from './mobile-worker-auto-close'
import { mobileSessionTabMenuHeader } from './MobileSessionTabMark'
import type { MobileSessionController } from '../use-mobile-session-controller'

/** The tapped terminal tab's actions: chat view, display size, rename, clear, close. */
export function MobileTerminalTabActionSheet({
  controller
}: {
  controller: MobileSessionController
}) {
  const t = useMobileTranslation()
  const { actionTarget, setActionTarget, sessionTabs } = controller
  const workerActions = useMobileAllowAutoCloseActions(
    controller.client,
    actionTarget && { terminal: actionTarget.handle }
  )
  const terminalTabs = sessionTabs.filter((tab) => tab.type === 'terminal')
  return (
    <ActionSheetModal
      visible={actionTarget != null}
      {...mobileSessionTabMenuHeader(
        actionTarget && terminalTabs.find((tab) => tab.terminal === actionTarget.handle),
        controller.terminals
      )}
      groupDestructive
      title={actionTarget?.title || t('session.sheets.terminal', 'Terminal')}
      actions={getMobileTerminalActionSheetActions({
        target: actionTarget,
        tabs: terminalTabs,
        isTabChatView: controller.nativeChatController.isTabChatView,
        hostCapabilities: controller.hostCapabilities,
        nativeChatTranscriptIsLocalReadable: controller.nativeChatTranscriptIsLocalReadable,
        onDismiss: () => setActionTarget(null),
        onToggleChat: controller.toggleTabChatView,
        isPhoneMode: (handle) => isTerminalPhoneDisplayMode(handle, controller.terminalModes),
        onToggleDisplayMode: (handle) => void controller.toggleDisplayMode(handle),
        onRename: controller.setRenameTarget,
        onClear: (target) => void controller.handleClearTerminal(target),
        onClose: (target) => void controller.handleCloseTerminal(target),
        onCloseSessionTab: (tab) => void controller.handleCloseSessionTab(tab),
        bulkCloseActions: controller.bulkCloseActions,
        workerActions
      })}
      onClose={() => setActionTarget(null)}
    />
  )
}
