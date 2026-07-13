import { Eraser, Monitor, Smartphone } from 'lucide-react-native'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import type { MobileNativeChatTab } from './mobile-native-chat-eligibility'
import { getMobileNativeChatToggleActions } from './mobile-native-chat-toggle-action'

type TerminalTab = MobileNativeChatTab & { id: string; terminal: string | null }

/** Builds the terminal long-press menu without adding another action block to the
 *  already dense session route. Native chat stays first as the view switch. */
export function getMobileTerminalActionSheetActions<Target extends { handle: string }>(args: {
  target: Target | null
  tabs: readonly TerminalTab[]
  chatTabIds: ReadonlySet<string>
  nativeChatTranscriptIsLocalReadable: boolean
  onDismiss: () => void
  onToggleChat: (tabId: string) => void
  isPhoneMode: (handle: string) => boolean
  onToggleDisplayMode: (handle: string) => void
  onRename: (target: Target) => void
  onClear: (target: Target) => void
  onClose: (target: Target) => void
}): ActionSheetAction[] {
  const { target } = args
  if (!target) {
    return []
  }
  const phoneMode = args.isPhoneMode(target.handle)
  return [
    ...getMobileNativeChatToggleActions({
      terminalHandle: target.handle,
      tabs: args.tabs,
      chatTabIds: args.chatTabIds,
      nativeChatTranscriptIsLocalReadable: args.nativeChatTranscriptIsLocalReadable,
      onClose: args.onDismiss,
      onToggle: args.onToggleChat
    }),
    {
      label: phoneMode ? 'Switch to Desktop' : 'Switch to Phone',
      icon: phoneMode ? Monitor : Smartphone,
      onPress: () => {
        args.onDismiss()
        args.onToggleDisplayMode(target.handle)
      }
    },
    {
      label: 'Rename',
      onPress: () => {
        args.onDismiss()
        args.onRename(target)
      }
    },
    {
      label: 'Clear Terminal',
      icon: Eraser,
      onPress: () => {
        args.onDismiss()
        args.onClear(target)
      }
    },
    {
      label: 'Close',
      destructive: true,
      onPress: () => {
        args.onDismiss()
        args.onClose(target)
      }
    }
  ]
}
