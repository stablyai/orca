import type { MobileNativeChatController } from '../mobile-native-chat-controller-contract'
import type { MobileNativeChatAgentPresence } from './use-mobile-native-chat-agent-presence'

const refuseWrite = async (): Promise<boolean> => false

/** After a terminal chat's agent exits nothing it shows is working, and nothing it sends reaches the shell. */
export function withMobileNativeChatAgentPresence(
  controller: MobileNativeChatController,
  agentPresence: MobileNativeChatAgentPresence
): MobileNativeChatController {
  const tracked = { ...controller, nativeChatAgentPresence: agentPresence }
  if (!agentPresence.presence.exit || controller.nativeChatStructured) {
    return tracked
  }
  return {
    ...tracked,
    nativeChatTurnActive: false,
    nativeChatTurnIndicator: null,
    nativeChatAwaitingInput: null,
    nativeChatCanStop: false,
    nativeChatAsk: null,
    nativeChatPermission: null,
    // Option commands are writes too; with no agent running they would reach the shell.
    nativeChatSessionOptions: null,
    handleNativeChatAnswerAsk: refuseWrite,
    handleNativeChatRespondPermission: refuseWrite,
    handleNativeChatSend: refuseWrite,
    handleNativeChatSendWithOutcome: async () => 'rejected'
  }
}
