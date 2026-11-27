import { MessageSquare } from 'lucide-react-native'
import type { ActionSheetAction } from '../../../components/sheets/ActionSheetModal'
import type { Translate } from '../../../i18n/mobile-i18n'
import type { MobileSessionTab } from '../../tabs/mobile-session-tabs'
import { resolveMobileNativeChat } from '../conversation/mobile-native-chat-eligibility'
import {
  adoptsCliConversations,
  type CliConversationRowAgent
} from '../../../../../src/shared/agent-session/view/structured-agent-cli-conversation-adoption'
import { STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import { SESSION_TABS_CONTINUE_TERMINAL_IN_CHAT_RUNTIME_CAPABILITY } from '../../../../../src/shared/remote-runtime/protocol/session-tabs-runtime-capabilities'

type TerminalTab = Extract<MobileSessionTab, { type: 'terminal' }>

/** A terminal pane's conversation, as the host's status row names it. */
export type MobileTerminalChatContinuation = {
  tab: TerminalTab
  terminal: string
  agent: CliConversationRowAgent
  providerSessionId: string
  /** The host's own pane key, so writer checks and the CLI source match its rows. */
  paneKey: string
}

/** A terminal whose agent's conversation a chat can take over, on a host that lets a phone do it;
 *  a server workspace's gates are that server's own.
 *  Agents with the in-place chat view keep that instead, so a tab never offers both. */
export function resolveMobileTerminalChatContinuation(args: {
  tab: MobileSessionTab | null | undefined
  hostCapabilities: readonly string[] | undefined
}): MobileTerminalChatContinuation | null {
  const { tab, hostCapabilities } = args
  if (
    tab?.type !== 'terminal' ||
    !tab.terminal ||
    !hostCapabilities?.includes(SESSION_TABS_CONTINUE_TERMINAL_IN_CHAT_RUNTIME_CAPABILITY) ||
    !hostCapabilities.includes(STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY) ||
    resolveMobileNativeChat(tab, true)
  ) {
    return null
  }
  const status = tab.agentStatus
  const agent = status?.agentType
  const providerSessionId = status?.providerSession?.id
  if (!adoptsCliConversations(agent) || !providerSessionId || !status?.paneKey) {
    return null
  }
  return { tab, terminal: tab.terminal, agent, providerSessionId, paneKey: status.paneKey }
}

export function getMobileTerminalChatContinuationActions(args: {
  continuation: MobileTerminalChatContinuation | null
  onDismiss: () => void
  onContinue: (continuation: MobileTerminalChatContinuation) => void
  t: Translate
}): ActionSheetAction[] {
  const { continuation } = args
  if (!continuation) {
    return []
  }
  return [
    {
      id: 'continueInChat',
      label: args.t('session.terminalChatContinuation.continueInChat', 'Continue in chat'),
      icon: MessageSquare,
      onPress: () => {
        args.onDismiss()
        args.onContinue(continuation)
      }
    }
  ]
}
