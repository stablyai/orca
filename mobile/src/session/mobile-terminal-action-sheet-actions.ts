import { Eraser, Monitor, Smartphone } from 'lucide-react-native'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { translate } from '../i18n/mobile-i18n'
import type { MobileNativeChatTab } from './native-chat/mobile-native-chat-eligibility'
import { getMobileNativeChatToggleActions } from './mobile-native-chat-toggle-action'

type TerminalTab = MobileNativeChatTab & { id: string; terminal: string | null }

export function getMobileTerminalActionSheetActions<
  Target extends { handle: string },
  Tab extends TerminalTab
>(args: {
  target: Target | null
  tabs: readonly Tab[]
  isTabChatView: (tabId: string) => boolean
  nativeChatTranscriptIsLocalReadable: boolean
  onDismiss: () => void
  onToggleChat: (tabId: string) => void
  isPhoneMode: (handle: string) => boolean
  onToggleDisplayMode: (handle: string) => void
  onRename: (target: Target) => void
  onClear: (target: Target) => void
  /** Fallback for a live handle with no matching session tab. */
  onClose: (target: Target) => void
  /** Preferred path runs host teardown and records the local tombstone. */
  onCloseSessionTab: (tab: Tab) => void
  bulkCloseActions?: (anchorTabId: string | undefined) => ActionSheetAction[]
  /** Allow Auto-Close, on a worker the user kept open. */
  workerActions?: ActionSheetAction[]
}): ActionSheetAction[] {
  const { target } = args
  if (!target) {
    return []
  }
  const phoneMode = args.isPhoneMode(target.handle)
  const sessionTab = args.tabs.find((tab) => tab.terminal === target.handle)
  return [
    ...getMobileNativeChatToggleActions({
      terminalHandle: target.handle,
      tabs: args.tabs,
      isTabChatView: args.isTabChatView,
      nativeChatTranscriptIsLocalReadable: args.nativeChatTranscriptIsLocalReadable,
      onClose: args.onDismiss,
      onToggle: args.onToggleChat
    }),
    {
      id: 'toggleDisplayMode',
      label: phoneMode
        ? translate('session.terminalActionSheetActions.switchToDesktop', 'Switch to Desktop')
        : translate('session.terminalActionSheetActions.switchToPhone', 'Switch to Phone'),
      icon: phoneMode ? Monitor : Smartphone,
      onPress: () => {
        args.onDismiss()
        args.onToggleDisplayMode(target.handle)
      }
    },
    {
      id: 'rename',
      label: translate('session.terminalActionSheetActions.rename', 'Rename'),
      closeBeforePress: true,
      onPress: () => {
        args.onRename(target)
      }
    },
    {
      id: 'clearTerminal',
      label: translate('session.terminalActionSheetActions.clearTerminal', 'Clear Terminal'),
      icon: Eraser,
      onPress: () => {
        args.onDismiss()
        args.onClear(target)
      }
    },
    ...(args.workerActions ?? []),
    {
      id: 'close',
      label: translate('common.close', 'Close'),
      destructive: true,
      onPress: () => {
        args.onDismiss()
        if (sessionTab) {
          args.onCloseSessionTab(sessionTab)
          return
        }
        args.onClose(target)
      }
    },
    ...(args.bulkCloseActions?.(sessionTab?.id) ?? [])
  ]
}
