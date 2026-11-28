import { ActionSheetModal } from '../../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { getMobileTerminalActionSheetActions } from '../../terminal/session/tab-actions/mobile-terminal-action-sheet-actions'
import { isTerminalPhoneDisplayMode } from '../../terminal/session/pane-layout/terminal-phone-display-mode'
import { useMobileAllowAutoCloseActions } from './mobile-worker-auto-close'
import { mobileSessionTabMenuHeader } from './MobileSessionTabMark'
import type { MobileSessionController } from '../use-mobile-session-controller'
import {
  getMobileTerminalChatContinuationActions,
  resolveMobileTerminalChatContinuation
} from '../native-chat/history/mobile-terminal-chat-continuation-actions'
import { continueMobileTerminalInChat } from '../mobile-terminal-chat-continuation'

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
  const targetTab = actionTarget && terminalTabs.find((tab) => tab.terminal === actionTarget.handle)
  const chatContinuationActions = getMobileTerminalChatContinuationActions({
    continuation: resolveMobileTerminalChatContinuation({
      tab: targetTab,
      hostCapabilities: controller.hostCapabilities
    }),
    onDismiss: () => setActionTarget(null),
    onContinue: (continuation) => void continueMobileTerminalInChat(controller, continuation),
    t
  }).map((action) => ({
    ...action,
    disabled: controller.createTabBusy || controller.connState !== 'connected'
  }))
  return (
    <ActionSheetModal
      visible={actionTarget != null}
      {...mobileSessionTabMenuHeader(targetTab, controller.terminals, t)}
      groupDestructive
      title={actionTarget?.title || t('session.sheets.terminal', 'Terminal')}
      actions={getMobileTerminalActionSheetActions({
        target: actionTarget,
        tabs: terminalTabs,
        isTabChatView: controller.nativeChatController.isTabChatView,
        nativeChatTranscriptIsLocalReadable: controller.nativeChatTranscriptIsLocalReadable,
        onDismiss: () => setActionTarget(null),
        onToggleChat: controller.toggleTabChatView,
        chatContinuationActions,
        isPhoneMode: (handle) => isTerminalPhoneDisplayMode(handle, controller.terminalModes),
        onToggleDisplayMode: (handle) => void controller.toggleDisplayMode(handle),
        onRename: controller.setRenameTarget,
        onClear: (target) => void controller.handleClearTerminal(target),
        onClose: (target) => void controller.handleCloseTerminal(target),
        onCloseSessionTab: (tab) => void controller.handleCloseSessionTab(tab),
        bulkCloseActions: controller.bulkCloseActions,
        workerActions,
        t
      })}
      onClose={() => setActionTarget(null)}
    />
  )
}
