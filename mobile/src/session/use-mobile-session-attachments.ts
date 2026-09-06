import { useEffect } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { triggerSelection, triggerError } from '../platform/haptics'
import { loadMobileNewTabAgentOptions } from './mobile-new-tab-agent-loader'
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
    getActiveWorktreeConnectionId,
    beforeTerminalSend: flushPendingLiveInputBeforeAttachmentSend,
    nativeChatBaseSend: nativeChatController.handleNativeChatSendWithOutcome,
    structuredNativeChat: activeSessionTab?.type === 'agent-session',
    readSeededLaunchDraft: nativeChatController.readSeededLaunchDraft,
    showToast,
    onNativeChatSendError: nativeChatSendError.show,
    onSuccess: triggerSelection,
    onError: triggerError
  })

  // Why: refresh canPaste on mount, AppState active, after paste.
  useEffect(() => {
    let mounted = true
    const refresh = () => {
      void Promise.all([
        Clipboard.hasStringAsync().catch(() => false),
        Clipboard.hasImageAsync().catch(() => false)
      ]).then(([hasString, hasImage]) => {
        if (mounted) {
          setCanPaste(hasString || hasImage)
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
  }, [selectModeActive])

  useEffect(() => {
    const shouldLoadAgentOptions = showCreateTabDrawer || pendingDiffNotesDelivery !== null
    if (!shouldLoadAgentOptions) {
      setCreateTabAgentLoadState('idle')
      setCreateTabAgentOptions([])
      return
    }
    if (!client || connState !== 'connected') {
      setCreateTabAgentLoadState('idle')
      setCreateTabAgentOptions([])
      return
    }

    let stale = false
    setCreateTabAgentLoadState('loading')
    setCreateTabAgentOptions([])

    void (async () => {
      const options = await loadMobileNewTabAgentOptions({
        client,
        worktreeId
      })
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
  }, [client, connState, pendingDiffNotesDelivery, showCreateTabDrawer, worktreeId])
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
