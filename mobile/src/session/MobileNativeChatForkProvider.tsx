import { useCallback, useLayoutEffect, useRef } from 'react'
import type { AgentSessionHandleProvider } from '../../../src/shared/agent-session/lifecycle/agent-session-provider-handle'
import type { StructuredAgentSessionForkSource } from '../../../src/shared/agent-session/structured-agent-session-create'
import { MobileNativeChatForkedFromContext } from './mobile-native-chat-notice-context'
import { forkMobileStructuredChat } from './mobile-structured-chat-fork'
import {
  MobileNativeChatForkContext,
  useMobileNativeChatFork
} from './native-chat/use-mobile-native-chat-fork'
import { resolveMobileNativeChatSessionId } from './native-chat/mobile-native-chat-eligibility'
import { useMobileForkSourceNavigation } from './use-mobile-fork-source-navigation'
import type { MobileSessionController } from './use-mobile-session-controller'

/** The chat's "Fork from this response" and the chat a "Forked from" divider opens. */
export function MobileNativeChatForkProvider({
  controller,
  navigate,
  children
}: {
  controller: MobileSessionController
  navigate: (worktreeId: string, paneKey: string) => void
  children: React.ReactNode
}): React.JSX.Element {
  const { client, nativeChatController: chat } = controller
  // The controller is rebuilt each render; a fork reads its session state at the press.
  const latestController = useRef(controller)
  useLayoutEffect(() => {
    latestController.current = controller
  })
  const createFork = useCallback(
    (agent: AgentSessionHandleProvider, forkFrom: StructuredAgentSessionForkSource) =>
      forkMobileStructuredChat(latestController.current, agent, forkFrom),
    []
  )
  const fork = useMobileNativeChatFork({
    client,
    hostCapabilities: controller.hostCapabilities,
    agent: chat.nativeChatAgent,
    sessionId: resolveMobileNativeChatSessionId(controller.activeSessionTab),
    messages: chat.nativeChatSession.messages,
    turnJournal: chat.nativeChatTurnJournal,
    agentWorking: chat.nativeChatTurnActive,
    sessionForkSupport: chat.nativeChatForkSupport,
    createFork
  })
  const openSource = useMobileForkSourceNavigation(
    client,
    navigate,
    controller.showToast,
    controller.worktreeId
  )
  return (
    <MobileNativeChatForkContext.Provider value={fork}>
      <MobileNativeChatForkedFromContext.Provider value={openSource}>
        {children}
      </MobileNativeChatForkedFromContext.Provider>
    </MobileNativeChatForkContext.Provider>
  )
}
