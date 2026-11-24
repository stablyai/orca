// The phone's chat for one of a teammate's chats with a shared agent: the regular native chat
// controller and composer, on the client to the agent's host. There is no workspace, terminal or tab
// around it; the chat is the page.
import { isStructuredAgentId } from '../../../../src/shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_LINK_OPEN_MODE, loadLinkOpenMode } from '../../storage/preferences'
import { useMobileSessionImageAttachments } from '../../files/attachments/use-mobile-session-image-attachments'
import { triggerError, triggerSelection } from '../../platform/haptics/haptics'
import { useMobileNativeChatStructuredComposer } from '../../session/native-chat/composer/commands/use-mobile-native-chat-structured-composer'
import { useMobileNativeChatSendError } from '../../session/native-chat/composer/delivery/use-mobile-native-chat-send-error'
import { mobileNativeChatScopeKey } from '../../session/native-chat/conversation/mobile-native-chat-scope-key'
import { structuredAgentSessionHostSupport } from '../../session/native-chat/agent-session/mobile-structured-agent-session-host-support'
import { useMobileNativeChatController } from '../../session/native-chat/use-mobile-native-chat-controller'
import { useMobileSendCompletionGeneration } from '../../session/use-mobile-send-completion-generation'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

const noTerminal = async () => false
const noConnection = async () => null

export function useSharedAgentChat(args: {
  client: RpcClient | null
  pairedHostClient: RpcClient | null
  hostId: string
  environmentId: string
  sessionId: string
  agent: string
  title: string
  capabilities: readonly string[] | null
  connState: ConnectionState
  showToast: (message: string) => void
}) {
  const { client, hostId, sessionId, agent, connState, showToast } = args
  // Its drafts and view are kept under the agent's host, as a workspace's are under its own.
  const worktreeId = `shared:${args.environmentId}`
  const tabId = `agent-session:${sessionId}`
  // The chat as the session screen's agent tab would name it.
  const tab = useMemo(
    () => ({
      type: 'agent-session' as const,
      id: tabId,
      title: args.title,
      sessionId,
      agent: isStructuredAgentId(agent) ? agent : 'claude',
      isActive: true
    }),
    [tabId, args.title, sessionId, agent]
  )
  const scopeKey = mobileNativeChatScopeKey(hostId, worktreeId, tabId)
  const sendError = useMobileNativeChatSendError({ scopeKey, showToast })
  const terminalRef = useRef<string | null>(null)
  const deviceTokenRef = useRef<string | null>(null)
  // What the host said it supports when last reached; sends need no read of it first.
  const hostSupport = useMemo(
    () => ({
      ...structuredAgentSessionHostSupport(args.capabilities ?? []),
      sendsWithoutFence: true
    }),
    [args.capabilities]
  )
  const controller = useMobileNativeChatController({
    client,
    pairedHostClient: args.pairedHostClient,
    hostId,
    worktreeId,
    activeSessionTab: tab,
    activeSessionTabId: tabId,
    activeHandleRef: terminalRef,
    deviceTokenRef,
    nativeChatTranscriptIsLocalReadable: false,
    nativeChatInputLeaseReady: false,
    connState,
    agentSessionHostSupport: hostSupport,
    onSendError: sendError.show,
    onQueuedEditNotice: showToast,
    onSendResolved: sendError.clear
  })
  sendError.bannerMountedRef.current = controller.showNativeChat
  sendError.keepWhile(controller.nativeChatCommandRefusalCauses)
  const getSendCompletionGeneration = useMobileSendCompletionGeneration({
    onBlur: () => {},
    surfaceKey: scopeKey ?? tabId
  })
  const { nativeChatImages: images, nativeChatFiles: files } = useMobileSessionImageAttachments({
    client,
    agent,
    activeHandle: null,
    activeHandleRef: terminalRef,
    canSend: false,
    connState,
    deviceTokenRef,
    nativeChatScopeKey: scopeKey,
    nativeChatInputLeaseReady: false,
    nativeChatAgentConfirmed: true,
    getActiveWorktreeConnectionId: noConnection,
    beforeTerminalSend: noTerminal,
    nativeChatBaseSend: controller.handleNativeChatSendWithOutcome,
    structuredNativeChat: true,
    nativeChatSessionId: sessionId,
    readSeededLaunchDraft: controller.readSeededLaunchDraft,
    showToast,
    onNativeChatSendError: sendError.show,
    onSuccess: triggerSelection,
    onError: triggerError
  })
  const structuredComposer = useMobileNativeChatStructuredComposer({
    structured: true,
    sessionCommands: controller.nativeChatSessionCommands,
    acceptsFiles: hostSupport?.phoneAttachments === true,
    conversationCommands: controller.nativeChatSessionOptions?.controller.conversationCommands,
    compactInstructions: controller.nativeChatSessionOptions?.controller.compactInstructions,
    files,
    threadGoal: controller.nativeChatThreadGoal,
    mcpPanel: controller.nativeChatMcpPanel,
    accountUsage: controller.nativeChatAccountUsage,
    onCommandNotice: sendError.show
  })
  const [linkOpenMode, setLinkOpenMode] = useState(DEFAULT_LINK_OPEN_MODE)
  useEffect(() => {
    void loadLinkOpenMode().then(setLinkOpenMode)
  }, [])
  return {
    tab,
    controller,
    linkOpenMode,
    images,
    structuredComposer,
    sendError,
    scopeKey,
    worktreeId,
    getSendCompletionGeneration
  }
}
