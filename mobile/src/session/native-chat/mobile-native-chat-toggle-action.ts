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
import { hermesResumeSessionId } from '../../../src/shared/hermes-session-id'
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
  /** terminal.list identity. Used only when the tab itself does not name an agent, and only for Hermes. */
  hostAgentIdentity?: string | null
  /** Host advertises resume-history, so a hook id can be session/load'd. */
  hermesResumeSupported?: boolean
  onClose: () => void
  onHermesTerminalChat?: (request: { tabId: string; providerSessionId: string | null }) => void
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
    const hermes = hermesTerminalChatAction(tab, args)
    if (hermes) {
      return [hermes]
    }
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

function hermesNamedTerminal(
  tab: MobileNativeChatTab,
  hostAgentIdentity: string | null | undefined
): boolean {
  const named = terminalLaunchAgent(tab)
  if (named === 'hermes') {
    return true
  }
  // A host identity must not relabel a terminal that already names another agent.
  return !named && hostAgentIdentity === 'hermes'
}

function hermesRegistered(structuredAgents: readonly string[]): boolean {
  return structuredAgents.length === 0 || structuredAgents.includes('hermes')
}

function hermesTerminalChatAction(
  tab: ToggleTab,
  args: {
    structuredAgents?: readonly string[]
    hostAgentIdentity?: string | null
    hermesResumeSupported?: boolean
    onClose: () => void
    onHermesTerminalChat?: (request: { tabId: string; providerSessionId: string | null }) => void
  }
): ActionSheetAction | null {
  if (!hermesNamedTerminal(tab, args.hostAgentIdentity)) {
    return null
  }
  if (!hermesRegistered(args.structuredAgents ?? [])) {
    return null
  }
  const providerSessionId = args.hermesResumeSupported
    ? hermesResumeSessionId(tab.agentStatus?.providerSession?.id)
    : null
  return {
    id: providerSessionId ? 'switchHermesTerminalToChat' : 'startHermesChat',
    label: providerSessionId
      ? translate('session.nativeChatToggleAction.switchHermesTerminalToChat', 'Switch to Chat')
      : translate('session.nativeChatToggleAction.startHermesChat', 'Start new chat'),
    icon: MessageSquare,
    onPress: () => {
      args.onClose()
      args.onHermesTerminalChat?.({ tabId: tab.id, providerSessionId })
    }
  }
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
