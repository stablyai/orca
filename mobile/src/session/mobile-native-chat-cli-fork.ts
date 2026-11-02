import { SquareTerminal } from 'lucide-react-native'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import type { MobileSessionController } from './use-mobile-session-controller'
import { agentForksConversations } from '../../../src/shared/agent-resume-argv'
import { SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY } from '../../../src/shared/session-tabs-runtime-capabilities'

/** The whole host fork-and-create contract must be present before the phone offers its action. */
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

/** The chat stays open; the existing terminal creator owns admission and selection. */
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
      label: 'Resume in New CLI',
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
