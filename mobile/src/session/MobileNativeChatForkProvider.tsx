import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import type { TuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent'
import type { StructuredAgentSessionForkSource } from '../../../src/shared/agent-session/structured-agent-session-create'
import { MobileNativeChatForkedFromContext } from './native-chat/transcript/mobile-native-chat-notice-context'
import { forkMobileStructuredChat } from './mobile-structured-chat-fork'
import {
  forkMobileStructuredChatIntoWorktree,
  type MobileWorktreeForkMode
} from './mobile-structured-chat-worktree-fork'
import { useMobileWorktreeForkRequest } from './native-chat/mobile-native-chat-worktree-fork-requests'
import { useNewWorktreeRuntimeCapabilities } from '../tasks/worktree-create-capability'
import { hostNewWorktreeSessionRoute } from '../host-new-worktree-session-route'
import {
  useWorkspaceExecutionHost,
  workspaceRouteHref
} from '../navigation/workspace-execution-host'
import { translate } from '../i18n/mobile-i18n'
import {
  MobileNativeChatForkContext,
  useMobileNativeChatFork
} from './native-chat/use-mobile-native-chat-fork'
import { resolveMobileNativeChatSessionId } from './native-chat/mobile-native-chat-eligibility'
import type { MobileSessionController } from './use-mobile-session-controller'

/** The chat's "Fork from this response" and the chat a "Forked from" divider opens. */
export function MobileNativeChatForkProvider({
  controller,
  children
}: {
  controller: MobileSessionController
  children: React.ReactNode
}): React.JSX.Element {
  const { client, nativeChatController: chat, openNativeSession, worktreeId } = controller
  const { statusPending } = useHostProtocolGates()
  // The controller is rebuilt each render; a fork reads its session state at the press.
  const latestController = useRef(controller)
  useLayoutEffect(() => {
    latestController.current = controller
  })
  const terminal = controller.activeSessionTab?.type === 'terminal'
  const createFork = useCallback(
    async (agent: TuiAgent, forkFrom: StructuredAgentSessionForkSource) => {
      const current = latestController.current
      // A terminal chat forks into a new terminal resuming a cut copy of its transcript.
      if (current.activeSessionTab?.type === 'terminal') {
        await current.handleCreateTerminal(undefined, {
          sourceChatFork: {
            sessionId: forkFrom.sessionId,
            agent,
            throughEntryId: forkFrom.throughItemId
          }
        })
        return
      }
      return forkMobileStructuredChat(current, agent, forkFrom)
    },
    []
  )
  const executionHost = useWorkspaceExecutionHost()
  const { getWorktreeCreateCutoverSupport } = useNewWorktreeRuntimeCapabilities(client, true)
  const createWorktreeFork = useCallback(
    (agent: TuiAgent, forkFrom: StructuredAgentSessionForkSource, mode: MobileWorktreeForkMode) => {
      const current = latestController.current
      return forkMobileStructuredChatIntoWorktree({
        mode,
        terminal: current.activeSessionTab?.type === 'terminal',
        sourceLabel: current.activeSessionTab?.title || undefined,
        client: current.client,
        sourceWorktreeId: current.worktreeId,
        agent,
        forkFrom,
        worktreeCreateIdempotency: getWorktreeCreateCutoverSupport(),
        showToast: current.showToast,
        openWorktree: (worktreeId, name, warning) =>
          current.router.push(
            workspaceRouteHref(
              hostNewWorktreeSessionRoute(current.hostId, worktreeId, name, warning),
              executionHost
            )
          )
      })
    },
    [executionHost, getWorktreeCreateCutoverSupport]
  )
  const fork = useMobileNativeChatFork({
    client,
    hostCapabilities: controller.hostCapabilities,
    hostStatusPending: statusPending || controller.connState !== 'connected',
    agent: chat.nativeChatAgent,
    sessionId: resolveMobileNativeChatSessionId(controller.activeSessionTab),
    messages: chat.nativeChatSession.messages,
    turnJournal: chat.nativeChatTurnJournal,
    agentWorking: chat.nativeChatTurnActive,
    sessionForkSupport: chat.nativeChatForkSupport,
    createFork,
    createWorktreeFork,
    terminal
  })
  const showNothingToFork = useCallback(
    () =>
      latestController.current.showToast(
        translate('chat.fork.worktree.nothing', 'There’s no response to fork yet.'),
        3000
      ),
    []
  )
  useMobileWorktreeForkRequest(fork.forkLatestToWorktree, showNothingToFork)
  // A fork and its source share a workspace and host.
  const openSource = useMemo(
    () =>
      client
        ? (sourceSessionId: string) =>
            void openNativeSession({
              kind: 'history',
              structuredSession: { sessionId: sourceSessionId, workspaceId: worktreeId }
            })
        : undefined,
    [client, openNativeSession, worktreeId]
  )
  return (
    <MobileNativeChatForkContext.Provider value={fork}>
      <MobileNativeChatForkedFromContext.Provider value={openSource}>
        {children}
      </MobileNativeChatForkedFromContext.Provider>
    </MobileNativeChatForkContext.Provider>
  )
}
