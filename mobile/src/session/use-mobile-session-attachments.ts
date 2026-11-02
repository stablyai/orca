import { useEffect } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { useClipboardReader } from '../platform/clipboard'
import { triggerSelection, triggerError } from '../platform/haptics'
import { resolveMobileImageAttachmentAgent } from './mobile-image-paste-agent'
import { useMobileNewTabAgentOptions } from './use-mobile-new-tab-agent-options'
import { useMobileSessionImageAttachments } from './use-mobile-session-image-attachments'
import { useMobileNativeChatStructuredComposer } from './native-chat/composer/use-mobile-native-chat-structured-composer'
import {
  isMobileNativeChatAgentConfirmed,
  resolveMobileNativeChatSessionId
} from './native-chat/mobile-native-chat-eligibility'
import { useMobileAttachmentInputLeaseGate } from './use-mobile-attachment-input-lease-gate'
import { useMobileTerminalPaste } from './use-mobile-terminal-paste'
import { useMobileIncomingShareClaim } from '../share/use-mobile-incoming-share-claim'
import { saveMobileWorkspaceFile } from '../files/mobile-workspace-file-save'
import type { MobileSessionAccessorySelectionModel } from './use-mobile-session-accessory-selection'

// Shared documents land here in the workspace, so the agent reads them by a project path.
const SHARED_DOCUMENTS_DIRECTORY = 'docs'

export function useMobileSessionAttachments(scope: MobileSessionAccessorySelectionModel) {
  const {
    worktreeId,
    client,
    connState,
    hostCapabilities,
    activeHandle,
    pendingDiffNotesDelivery,
    showCreateTabDrawer,
    setCreateTabAgentLoadState,
    setCreateTabAgentOptions,
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
    hostId
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
  useMobileIncomingShareClaim({
    composerVisible:
      nativeChatController.showNativeChat && nativeChatController.chatDraftKey !== null,
    // Structured image support is known only once the host's capabilities load.
    canAttach:
      client !== null &&
      connState === 'connected' &&
      (structuredNativeChat ? agentSessionHostSupport != null : activeHandle !== null),
    acceptsImages: nativeChatController.nativeChatAcceptsImages,
    appendText: nativeChatController.appendChatComposerText,
    attachImages: (picked) => nativeChatImages.attachImage('files', picked),
    saveDocument: (file) => {
      if (!client) {
        return Promise.reject(new Error('disconnected'))
      }
      return saveMobileWorkspaceFile(client, {
        worktreeId,
        directory: SHARED_DOCUMENTS_DIRECTORY,
        name: file.name,
        base64: file.base64
      })
    },
    showToast
  })
  const nativeChatStructuredComposer = useMobileNativeChatStructuredComposer({
    structured: structuredNativeChat,
    sessionCommands: nativeChatController.nativeChatSessionCommands,
    acceptsFiles: agentSessionHostSupport?.phoneAttachments === true,
    conversationCommands:
      nativeChatController.nativeChatSessionOptions?.controller.conversationCommands,
    files: nativeChatFiles
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

  useMobileNewTabAgentOptions({
    client,
    connState,
    hostId,
    hostCapabilities,
    worktreeId,
    open: showCreateTabDrawer || pendingDiffNotesDelivery !== null,
    setLoadState: setCreateTabAgentLoadState,
    setOptions: setCreateTabAgentOptions
  })
  return {
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
