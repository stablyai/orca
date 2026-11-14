import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import type { TuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent'
import type { StructuredAgentSessionForkSource } from '../../../src/shared/agent-session/structured-agent-session-create'
import { MobileNativeChatForkedFromContext } from './native-chat/transcript/notices/mobile-native-chat-notice-context'
import { forkMobileStructuredChat } from './mobile-structured-chat-fork'
import {
  forkMobileStructuredChatIntoWorktree,
  mobileSubagentForkAvailable,
  type MobileWorktreeForkMode
} from './mobile-structured-chat-worktree-fork'
import { useMobileWorktreeForkRequest } from './native-chat/history/mobile-native-chat-worktree-fork-requests'
import { useNewWorktreeRuntimeCapabilities } from '../new-workspace/creation/worktree-create-capability'
import { hostNewWorktreeSessionRoute } from '../host-new-worktree-session-route'
import {
  useWorkspaceExecutionHost,
  workspaceRouteHref
} from '../navigation/workspace-execution-host'
import { translate } from '../i18n/mobile-i18n'
import {
  MobileNativeChatForkContext,
  useMobileNativeChatFork
} from './native-chat/history/use-mobile-native-chat-fork'
import { resolveMobileNativeChatSessionId } from './native-chat/conversation/mobile-native-chat-eligibility'
import { useMobileChatForkSheet } from './chat-fork/use-mobile-chat-fork-sheet'
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
    async (agent: TuiAgent, forkFrom: StructuredAgentSessionForkSource, recap?: string) => {
      const current = latestController.current
      // A terminal chat forks into a new terminal resuming a cut copy of its transcript.
      if (current.activeSessionTab?.type === 'terminal' && !recap) {
        await current.handleCreateTerminal(undefined, {
          sourceChatFork: {
            sessionId: forkFrom.sessionId,
            agent,
            throughEntryId: forkFrom.throughItemId
          }
        })
        return
      }
      return forkMobileStructuredChat(current, agent, forkFrom, recap)
    },
    []
  )
  const executionHost = useWorkspaceExecutionHost()
  const { getWorktreeCreateCutoverSupport } = useNewWorktreeRuntimeCapabilities(client, true)
  const createWorktreeFork = useCallback(
    (
      agent: TuiAgent,
      forkFrom: StructuredAgentSessionForkSource,
      mode: MobileWorktreeForkMode,
      recap?: string
    ) => {
      const current = latestController.current
      return forkMobileStructuredChatIntoWorktree({
        mode,
        recap,
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
    terminal
  })
  const forkSheet = useMobileChatForkSheet({
    fork,
    controller,
    latestController,
    createFork,
    createWorktreeFork,
    executionHost
  })
  const { open: openForkSheet } = forkSheet
  const forkContext = useMemo(() => ({ ...fork, openSheet: openForkSheet }), [fork, openForkSheet])
  // The header's and tab sheet's fork items open the sheet at their own preset, never a weaker one.
  const openLatestForkSheet = useCallback(
    (mode: MobileWorktreeForkMode): boolean => {
      const honoured =
        fork.worktreeForkOffered() &&
        (mode !== 'subagent' ||
          (latestController.current.activeSessionTab?.type !== 'terminal' &&
            mobileSubagentForkAvailable(fork.hostCapabilities())))
      const message = honoured ? fork.latestForkable() : undefined
      if (message) {
        openForkSheet(message, mode)
      }
      return !!message
    },
    [fork, openForkSheet]
  )
  const showNothingToFork = useCallback(
    () =>
      latestController.current.showToast(
        translate('chat.fork.worktree.nothing', 'There’s no response to fork yet.'),
        3000
      ),
    []
  )
  useMobileWorktreeForkRequest(openLatestForkSheet, showNothingToFork)
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
    <MobileNativeChatForkContext.Provider value={forkContext}>
      <MobileNativeChatForkedFromContext.Provider value={openSource}>
        {children}
      </MobileNativeChatForkedFromContext.Provider>
      {forkSheet.sheet}
    </MobileNativeChatForkContext.Provider>
  )
}
