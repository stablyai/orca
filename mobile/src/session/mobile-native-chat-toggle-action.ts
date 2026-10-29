import { MessageSquare, SquareTerminal } from 'lucide-react-native'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { translate } from '../i18n/mobile-i18n'
import {
  resolveMobileNativeChat,
  type MobileNativeChatTab
} from './native-chat/mobile-native-chat-eligibility'

type ToggleTab = MobileNativeChatTab & {
  id: string
  terminal: string | null
}

export function getMobileNativeChatToggleActions(args: {
  terminalHandle: string | null
  tabs: readonly ToggleTab[]
  isTabChatView: (tabId: string) => boolean
  nativeChatTranscriptIsLocalReadable: boolean
  onClose: () => void
  onToggle: (tabId: string) => void
}): ActionSheetAction[] {
  const { terminalHandle, tabs, isTabChatView, onClose, onToggle } = args
  const tab = terminalHandle
    ? tabs.find((candidate) => candidate.terminal === terminalHandle)
    : null
  if (!tab || !resolveMobileNativeChat(tab, args.nativeChatTranscriptIsLocalReadable)) {
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
