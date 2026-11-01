import { MessageSquare, SquareTerminal } from 'lucide-react-native'
<<<<<<< HEAD:mobile/src/session/native-chat/mobile-native-chat-toggle-action.ts
import type { ActionSheetAction } from '../../components/ActionSheetModal'
import { translate } from '../../i18n/mobile-i18n'
import { formatAgentTypeLabel } from '../../../../src/shared/agent-type-label'
import { isNativeChatSupportedAgent } from '../../../../src/shared/native-chat-agent-support'
import { resolveMobileNativeChat, type MobileNativeChatTab } from './mobile-native-chat-eligibility'
=======
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { translate } from '../i18n/mobile-i18n'
import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import { isNativeChatSupportedAgent } from '../../../src/shared/native-chat/native-chat-agent-support'
import {
  resolveMobileNativeChat,
  type MobileNativeChatTab
} from './native-chat/mobile-native-chat-eligibility'
>>>>>>> 1e0c318233c (fix(hermes): name a chat with Hermes and follow the moved import):mobile/src/session/mobile-native-chat-toggle-action.ts

type ToggleTab = MobileNativeChatTab & {
  id: string
  terminal: string | null
}

export function getMobileNativeChatToggleActions(args: {
  terminalHandle: string | null
  tabs: readonly ToggleTab[]
  isTabChatView: (tabId: string) => boolean
  nativeChatTranscriptIsLocalReadable: boolean
  structuredAgents?: readonly string[]
  onClose: () => void
  onToggle: (tabId: string) => void
}): ActionSheetAction[] {
  const { terminalHandle, tabs, isTabChatView, onClose, onToggle } = args
  const tab = terminalHandle
    ? tabs.find((candidate) => candidate.terminal === terminalHandle)
    : null
  if (!tab) {
    return []
  }
  if (!resolveMobileNativeChat(tab, args.nativeChatTranscriptIsLocalReadable)) {
    return structuredChatTerminalExplanation(tab, args.structuredAgents ?? [])
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

function terminalLaunchAgent(tab: MobileNativeChatTab): string | null {
  return tab.launchAgent ?? tab.agentStatus?.agentType ?? tab.agent ?? null
}

// A structured chat is a new session. The running terminal has no transcript this view can adopt.
function structuredChatTerminalExplanation(
  tab: MobileNativeChatTab,
  structuredAgents: readonly string[]
): ActionSheetAction[] {
  const agent = terminalLaunchAgent(tab)
  if (!agent || isNativeChatSupportedAgent(agent) || !structuredAgents.includes(agent)) {
    return []
  }
  return [
    {
      id: 'structuredChatUnavailable',
      label: translate(
        'session.nativeChatToggleAction.terminalCannotSwitchToChat',
        "Can't switch this {{agent}} terminal to Chat",
        { agent: formatAgentTypeLabel(agent) }
      ),
      hint: translate(
        'session.nativeChatToggleAction.startNewChatSession',
        'Start a new session with Chat UI on'
      ),
      icon: MessageSquare,
      disabled: true,
      onPress: () => {}
    }
  ]
}
