import { useEffect } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { useClipboardReader } from '../../platform/clipboard'
import { triggerSelection, triggerError } from '../../platform/haptics'
import { resolveMobileImageAttachmentAgent } from './mobile-image-paste-agent'
import { useMobileNewTabAgentOptions } from '../../session/agent-launch/use-mobile-new-tab-agent-options'
import { useMobileSessionImageAttachments } from './use-mobile-session-image-attachments'
import { useMobileNativeChatStructuredComposer } from '../../session/native-chat/composer/use-mobile-native-chat-structured-composer'
import {
  isMobileNativeChatAgentConfirmed,
  resolveMobileNativeChatSessionId
} from '../../session/native-chat/mobile-native-chat-eligibility'
import { useMobileAttachmentInputLeaseGate } from './use-mobile-attachment-input-lease-gate'
import { useMobileTerminalPaste } from '../../terminal/session/use-mobile-terminal-paste'
import type { MobileSessionAccessorySelectionModel } from '../../terminal/session/use-mobile-session-accessory-selection'

export function useMobileSessionAttachments(scope: MobileSessionAccessorySelectionModel) {
  const {
    worktreeId,
    client,
    connState,
    hostCapabilities,
    activeHandle,
    pendingDiffNotesDelivery,
    showCreateTabDrawer,
    selectModeActive,
    setCanPaste,
    ptyModesRef,
    deviceTokenRef,
    clientRef,
    connStateRef,
    terminalRefs,
    activeHandleRef,
    activeSessionTabTypeRef,
    flushPendingLiveInputBeforeExternalSend,
    canSend,
    showToast,
    nativeChatScopeKey,
    nativeChatSendError,
    nativeChatInputLeaseReadyRef,
    nativeChatInputLeaseReady,
    nativeChatController,
    getActiveWorktreeConnectionId,
    refreshCanPaste,
    activeSessionTab,
    agentSessionHostSupport,
    hostId,
    terminalsLoaded
  } = scope
  const clipboardContents = useClipboardReader().contents
  const agent = resolveMobileImageAttachmentAgent(
    activeSessionTab,
    nativeChatController.nativeChatAgent
  )
  const handlePaste = useMobileTerminalPaste({
    sendTerminalUserInput: scope.sendTerminalUserInput,
    client,
    agent,
    activeHandle,
    activeHandleRef,
    activeSessionTabTypeRef,
    canSend,
    connState,
    connStateRef,
    clientRef,
    deviceTokenRef,
    flushPendingLiveInputBeforeExternalSend,
    getActiveWorktreeConnectionId,
    onError: triggerError,
    onSuccess: triggerSelection,
    ptyModesRef,
    refreshCanPaste,
    showToast
  })

  const flushPendingLiveInputBeforeAttachmentSend = useMobileAttachmentInputLeaseGate({
    flushPendingLiveInputBeforeExternalSend,
    connStateRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    nativeChatInputLeaseReadyRef,
    showToast
  })

  const structuredNativeChat = activeSessionTab?.type === 'agent-session'
  const nativeChatSessionId = resolveMobileNativeChatSessionId(activeSessionTab)
  // Terminal attachments paste immediately; native chat defers composer chips until submit.
  const { attachImage, isAttaching, nativeChatImages, nativeChatFiles } =
    useMobileSessionImageAttachments({
      client,
      agent,
      activeHandle,
      activeHandleRef,
      canSend,
      connState,
      deviceTokenRef,
      nativeChatScopeKey,
      nativeChatInputLeaseReady,
      nativeChatAgentConfirmed: isMobileNativeChatAgentConfirmed(activeSessionTab),
      getActiveWorktreeConnectionId,
      beforeTerminalSend: flushPendingLiveInputBeforeAttachmentSend,
      nativeChatBaseSend: nativeChatController.handleNativeChatSendWithOutcome,
      structuredNativeChat,
      nativeChatSessionId,
      readSeededLaunchDraft: nativeChatController.readSeededLaunchDraft,
      showToast,
      onNativeChatSendError: nativeChatSendError.show,
      onSuccess: triggerSelection,
      onError: triggerError
    })
  const nativeChatStructuredComposer = useMobileNativeChatStructuredComposer({
    structured: structuredNativeChat,
    sessionCommands: nativeChatController.nativeChatSessionCommands,
    acceptsFiles: agentSessionHostSupport?.phoneAttachments === true,
    conversationCommands:
      nativeChatController.nativeChatSessionOptions?.controller.conversationCommands,
    compactInstructions:
      nativeChatController.nativeChatSessionOptions?.controller.compactInstructions,
    files: nativeChatFiles,
    threadGoal: nativeChatController.nativeChatThreadGoal
  })

  useEffect(() => {
    let mounted = true
    const refresh = () => {
      void clipboardContents().then(({ text, image }) => {
        if (mounted) {
          setCanPaste(text || image)
        }
      })
    }
    refresh()
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') {
        refresh()
      } else if (selectModeActive && activeHandleRef.current) {
        terminalRefs.current.get(activeHandleRef.current)?.cancelSelect()
      }
    })
    return () => {
      mounted = false
      sub.remove()
    }
  }, [clipboardContents, selectModeActive, setCanPaste])

  const createTabAgents = useMobileNewTabAgentOptions({
    client,
    connState,
    hostId,
    hostCapabilities,
    worktreeId,
    open: showCreateTabDrawer || pendingDiffNotesDelivery !== null,
    // After the session's own first reads, so the list is ready by the first "+" tap.
    prefetch: terminalsLoaded
  })
  return {
    createTabAgentLoadState: createTabAgents.loadState,
    createTabAgentOptions: createTabAgents.options,
    handlePaste,
    flushPendingLiveInputBeforeAttachmentSend,
    attachImage,
    isAttaching,
    nativeChatImages,
    nativeChatStructuredComposer
  }
}

export type MobileSessionAttachmentsModel = MobileSessionAccessorySelectionModel &
  ReturnType<typeof useMobileSessionAttachments>
