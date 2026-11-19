import { SquareTerminal } from 'lucide-react-native'
import type { ActionSheetAction } from '../../../components/sheets/ActionSheetModal'
import { translate } from '../../../i18n/mobile-i18n'
import type { MobileSessionController } from '../../use-mobile-session-controller'
import { agentForksConversations } from '../../../../../src/shared/agent-launch/startup/agent-resume-argv'
import { SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY } from '../../../../../src/shared/remote-runtime/protocol/session-tabs-runtime-capabilities'

export function canOfferMobileNativeChatCliFork(args: {
  agent: string
  hostCapabilities: readonly string[] | undefined
}): boolean {
  return (
    agentForksConversations(args.agent) &&
    args.hostCapabilities?.includes(SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY) === true
  )
}

export function getMobileNativeChatCliForkActions(args: {
  controller: Pick<MobileSessionController, 'client' | 'hostCapabilities' | 'handleCreateTerminal'>
  tab: { sessionId: string; agent: string } | null
  onDismiss: () => void
}): ActionSheetAction[] {
  const { client, hostCapabilities, handleCreateTerminal } = args.controller
  const { tab } = args
  if (!client || !tab || !agentForksConversations(tab.agent)) {
    return []
  }
  return [
    {
      id: 'resumeInNewCli',
      label: translate('session.nativeChatCliFork.resumeInNewCli', 'Resume in New CLI'),
      icon: SquareTerminal,
      disabled: !canOfferMobileNativeChatCliFork({ agent: tab.agent, hostCapabilities }),
      hint: canOfferMobileNativeChatCliFork({ agent: tab.agent, hostCapabilities })
        ? undefined
        : translate(
            'agentHistory.actions.updateHost',
            'Update Orca on this host to use this action'
          ),
      onPress: () => {
        args.onDismiss()
        void handleCreateTerminal(undefined, {
          sourceChatFork: { sessionId: tab.sessionId, agent: tab.agent }
        })
      }
    }
  ]
}
