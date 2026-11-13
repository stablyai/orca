import { useEffect } from 'react'
import { useMobileSessionTabReader } from './use-mobile-session-tab-reader'
import { useMobileSessionDictation } from './use-mobile-session-dictation'
import { useMobileNativeChatController } from './native-chat/use-mobile-native-chat-controller'
import { useMobileNativeChatReadability } from './native-chat/transcript/use-mobile-native-chat-readability'
import { useMobileNativeChatInputLease } from './native-chat/composer/use-mobile-native-chat-input-lease'
import { useMobileNativeChatSendError } from './native-chat/composer/use-mobile-native-chat-send-error'
import { mobileNativeChatScopeKey } from './native-chat/mobile-native-chat-scope-key'
import { mobileNativeChatOverlayInputLockReason } from './native-chat/mobile-native-chat-overlay-lock-reason'
import { useMobileSendCompletionGeneration } from './use-mobile-send-completion-generation'
import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'

export function useMobileSessionNativeChatDictation(
  scope: MobileSessionFeedbackCapabilitiesModel,
  sendLiveTerminalInput: (handle: string, bytes: string) => Promise<boolean>
) {
  const {
    hostId,
    worktreeId,
    client,
    pairedHostClient,
    connState,
    agentSessionHostSupport,
    activeHandle,
    activeSessionTabId,
    diffComments,
    diffCommentsRef,
    deviceTokenRef,
    activeHandleRef,
    activeSessionTab,
    showToast,
    resetLiveInputFocus
  } = scope
  const nativeChatScopeKey = mobileNativeChatScopeKey(hostId, worktreeId, activeSessionTabId)
  const nativeChatSendError = useMobileNativeChatSendError({
    scopeKey: nativeChatScopeKey,
    showToast
  })
  const nativeChatTranscriptIsLocalReadable = useMobileNativeChatReadability(client, worktreeId)
  const {
    ready: nativeChatInputLeaseReady,
    readyRef: nativeChatInputLeaseReadyRef,
    lockReason: nativeChatInputLockReason,
    markReady: markNativeChatInputLeaseReady,
    clear: clearNativeChatInputLease
  } = useMobileNativeChatInputLease({
    activeHandle,
    connected: connState === 'connected'
  })
  const { readSessionTab } = useMobileSessionTabReader(hostId, worktreeId, scope.sessionTabsRef)
  const nativeChatController = useMobileNativeChatController({
    client,
    pairedHostClient,
    hostId,
    worktreeId,
    activeSessionTab,
    activeSessionTabId,
    readSessionTab,
    activeHandleRef,
    deviceTokenRef,
    nativeChatTranscriptIsLocalReadable,
    nativeChatInputLeaseReady,
    connState,
    agentSessionHostSupport,
    onSendError: nativeChatSendError.show,
    onQueuedEditNotice: showToast,
    onSendResolved: nativeChatSendError.clear
  })
  const { toggleTabChatView, showNativeChat, showNativeChatRef } = nativeChatController
  nativeChatSendError.bannerMountedRef.current = showNativeChat
  nativeChatSendError.keepWhile(nativeChatController.nativeChatCommandRefusalCauses)
  const nativeChatOverlayInputLockReason = mobileNativeChatOverlayInputLockReason(
    activeSessionTab,
    connState,
    nativeChatInputLockReason
  )
  const routeKey = nativeChatScopeKey ?? `${hostId}\0${worktreeId}`
  const getSendCompletionGeneration = useMobileSendCompletionGeneration({
    onBlur: resetLiveInputFocus,
    surfaceKey: JSON.stringify([routeKey, activeHandle, showNativeChat])
  })

  const sessionDictation = useMobileSessionDictation(
    scope,
    nativeChatController,
    sendLiveTerminalInput
  )

  useEffect(() => {
    diffCommentsRef.current = diffComments
  }, [diffComments])
  return {
    nativeChatScopeKey,
    nativeChatSendError,
    nativeChatTranscriptIsLocalReadable,
    nativeChatInputLeaseReady,
    nativeChatInputLeaseReadyRef,
    nativeChatInputLockReason,
    nativeChatOverlayInputLockReason,
    markNativeChatInputLeaseReady,
    clearNativeChatInputLease,
    nativeChatController,
    getSendCompletionGeneration,
    toggleTabChatView,
    showNativeChat,
    showNativeChatRef,
    ...sessionDictation
  }
}

export type MobileSessionNativeChatDictationModel = MobileSessionFeedbackCapabilitiesModel &
  ReturnType<typeof useMobileSessionNativeChatDictation>
