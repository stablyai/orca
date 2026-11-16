import { MessageSquare, SquareTerminal } from 'lucide-react-native'
import type { ActionSheetAction } from '../../../components/sheets/ActionSheetModal'
import { translate } from '../../../i18n/mobile-i18n'
import { resolveMobileNativeChat, type MobileNativeChatTab } from './mobile-native-chat-eligibility'

export function getMobileNativeChatToggleActions(args: {
  tab: (MobileNativeChatTab & { id: string }) | null
  isTabChatView: (tabId: string) => boolean
  nativeChatTranscriptIsLocalReadable: boolean
  onClose: () => void
  onToggle: (tabId: string) => void
}): ActionSheetAction[] {
  const { tab, isTabChatView, onClose, onToggle } = args
  // Structured agent-session tabs have no same-tab terminal to switch to.
  if (
    tab?.type !== 'terminal' ||
    !resolveMobileNativeChat(tab, args.nativeChatTranscriptIsLocalReadable)
  ) {
    return []
  }
  const isChat = isTabChatView(tab.id)
  return [
    {
      id: 'toggleChatView',
      label: isChat
        ? translate(
            'session.nativeChatToggleAction.switchToTerminalView',
            'Switch to terminal view'
          )
        : translate('session.nativeChatToggleAction.switchToChatView', 'Switch to chat view'),
      icon: isChat ? SquareTerminal : MessageSquare,
      onPress: () => {
        onClose()
        onToggle(tab.id)
      }
    }
  ]
}
