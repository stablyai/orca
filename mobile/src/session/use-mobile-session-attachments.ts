import { useEffect } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { useMobileSessionImageAttachments } from './use-mobile-session-image-attachments'
import { useMobileAttachmentInputLeaseGate } from './use-mobile-attachment-input-lease-gate'
import { useMobileTerminalPaste } from './use-mobile-terminal-paste'
import type { MobileSessionAccessorySelectionModel } from './use-mobile-session-accessory-selection'

export function useMobileSessionAttachments(scope: MobileSessionAccessorySelectionModel) {
  const {
    worktreeId,
    client,
    connState,
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
    sessionDeviceOperations,
    sessionNativeChatOperations,
    sessionTabOperations,
    sessionTerminalOperations,
    triggerError,
    triggerSelection,
    activeSessionTab
  } = scope
  const handlePaste = useMobileTerminalPaste({
    client,
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
    showToast,
    terminalOperations: sessionTerminalOperations
  })

  const flushPendingLiveInputBeforeAttachmentSend = useMobileAttachmentInputLeaseGate({
    flushPendingLiveInputBeforeExternalSend,
    connStateRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    nativeChatInputLeaseReadyRef,
    showToast
  })

  // Terminal input pastes an attached image straight into the visible terminal;
  // native chat instead holds it as a composer chip and rides it along on submit.
  const { attachImage, isAttaching, nativeChatImages } = useMobileSessionImageAttachments({
    client,
    activeHandle,
    activeHandleRef,
    canSend,
    connState,
    deviceTokenRef,
    nativeChatScopeKey,
    nativeChatInputLeaseReady,
    nativeChatOperations: sessionNativeChatOperations,
    nativeChatTargetRef: nativeChatController.nativeChatTargetRef,
    getActiveWorktreeConnectionId,
    beforeTerminalSend: flushPendingLiveInputBeforeAttachmentSend,
    nativeChatBaseSend: nativeChatController.handleNativeChatSendWithOutcome,
    structuredNativeChat: activeSessionTab?.type === 'agent-session',
    readSeededLaunchDraft: nativeChatController.readSeededLaunchDraft,
    showToast,
    onNativeChatSendError: nativeChatSendError.show,
    onSuccess: triggerSelection,
    onError: triggerError,
    terminalOperations: sessionTerminalOperations
  })

  // Why: refresh canPaste on mount, AppState active, after paste.
  useEffect(() => {
    let mounted = true
    const refresh = () => {
      void sessionDeviceOperations
        ?.clipboardAvailability()
        .then(({ hasText, hasImage }) => {
          if (mounted) {
            setCanPaste(hasText || hasImage)
          }
        })
        .catch(() => {
          if (mounted) {
            setCanPaste(false)
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
  }, [selectModeActive, sessionDeviceOperations])

  useEffect(() => {
    const shouldLoadAgentOptions =
      showCreateTabDrawer || (Boolean(client) && pendingDiffNotesDelivery !== null)
    if (!shouldLoadAgentOptions) {
      setCreateTabAgentLoadState('idle')
      setCreateTabAgentOptions([])
      return
    }
    if (!sessionTabOperations || connState !== 'connected') {
      setCreateTabAgentLoadState('idle')
      setCreateTabAgentOptions([])
      return
    }

    let stale = false
    setCreateTabAgentLoadState('loading')
    setCreateTabAgentOptions([])

    void (async () => {
      const options = await sessionTabOperations.agentOptions(worktreeId)
      if (stale) {
        return
      }
      setCreateTabAgentOptions(options)
      setCreateTabAgentLoadState('loaded')
    })().catch(() => {
      if (!stale) {
        setCreateTabAgentOptions([])
        setCreateTabAgentLoadState('error')
      }
    })

    return () => {
      stale = true
    }
  }, [
    client,
    connState,
    pendingDiffNotesDelivery,
    sessionTabOperations,
    showCreateTabDrawer,
    worktreeId
  ])
  return {
    handlePaste,
    flushPendingLiveInputBeforeAttachmentSend,
    attachImage,
    isAttaching,
    nativeChatImages
  }
}

export type MobileSessionAttachmentsModel = MobileSessionAccessorySelectionModel &
  ReturnType<typeof useMobileSessionAttachments>
