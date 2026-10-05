import { MessageSquare, SquareTerminal } from 'lucide-react-native'
import type { TerminalTabViewMode } from '../../../src/shared/terminal-tab-view-mode'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { resolveMobileNativeChat, type MobileNativeChatTab } from './mobile-native-chat-eligibility'
import type { MobileLeafView } from './mobile-session-chat-view'

type ToggleTab = MobileNativeChatTab & { id: string }

/** Builds the optional terminal/chat switch shown in a terminal's long-press menu. */
export function getMobileNativeChatToggleActions(args: {
  tab: ToggleTab | null
  /** The leaf's effective view; a chat leaf can always switch back, whatever its status says. */
  leafView: MobileLeafView
  nativeChatTranscriptIsLocalReadable: boolean
  onClose: () => void
  /** Receives the view the pressed item names, never a toggle computed later. */
  onSetView: (tabId: string, view: TerminalTabViewMode) => void
}): ActionSheetAction[] {
  const { tab, onClose, onSetView } = args
  if (!tab) {
    return []
  }
  const isChat = args.leafView === 'chat'
  // Why status or launch hint: chat is offered only for an agent the host can show a transcript for.
  if (!isChat && !resolveMobileNativeChat(tab, args.nativeChatTranscriptIsLocalReadable)) {
    return []
  }
  return [
    {
      label: isChat ? 'Switch to terminal view' : 'Switch to chat view',
      icon: isChat ? SquareTerminal : MessageSquare,
      onPress: () => {
        onClose()
        onSetView(tab.id, isChat ? 'terminal' : 'chat')
      }
    }
  ]
}
