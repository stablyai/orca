import { SquareTerminal } from 'lucide-react-native'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { translate } from '../i18n/mobile-i18n'
import type { MobileSessionController } from './use-mobile-session-controller'
import { agentForksConversations } from '../../../src/shared/agent-resume-argv'
import { SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY } from '../../../src/shared/session-tabs-runtime-capabilities'

export function canOfferMobileNativeChatCliFork(args: {
  agent: string
  hostCapabilities: readonly string[] | undefined
  workspaceOnPairedHost: boolean
}): boolean {
  return (
    args.workspaceOnPairedHost &&
    agentForksConversations(args.agent) &&
    args.hostCapabilities?.includes(SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY) === true
  )
}

export function getMobileNativeChatCliForkActions(args: {
  controller: Pick<MobileSessionController, 'client' | 'hostCapabilities' | 'handleCreateTerminal'>
  tab: { sessionId: string; agent: string } | null
  workspaceOnPairedHost: boolean
  onDismiss: () => void
}): ActionSheetAction[] {
  const { client, hostCapabilities, handleCreateTerminal } = args.controller
  const { tab } = args
  if (
    !client ||
    !tab ||
    !canOfferMobileNativeChatCliFork({
      agent: tab.agent,
      hostCapabilities,
      workspaceOnPairedHost: args.workspaceOnPairedHost
    })
  ) {
    return []
  }
  return [
    {
      id: 'resumeInNewCli',
      label: translate('session.nativeChatCliFork.resumeInNewCli', 'Resume in New CLI'),
      icon: SquareTerminal,
      onPress: () => {
        args.onDismiss()
        void handleCreateTerminal(undefined, {
          sourceChatFork: { sessionId: tab.sessionId, agent: tab.agent }
        })
      }
    }
  ]
}
