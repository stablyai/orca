import { useEffect } from 'react'
import type { MobileSessionItemLink } from './mobile-session-item-target'
import { useMobileScreenDictation } from './use-mobile-screen-dictation'
import { HOST_SESSION_ROUTE } from '../navigation/host-stack-navigation'
import {
  useWorkspaceExecutionHost,
  workspaceRouteHref
} from '../navigation/workspace-execution-host'
import { sessionTabPaneKey } from '../../../src/shared/remote-runtime/session-graph/session-tab-pane-key'
import { useMobileNativeChatController } from './native-chat/use-mobile-native-chat-controller'
import { useMobileNativeChatReadability } from './native-chat/transcript/viewport/use-mobile-native-chat-readability'
import { useMobileNativeChatInputLease } from './native-chat/composer/field/use-mobile-native-chat-input-lease'
import { useMobileNativeChatSendError } from './native-chat/composer/delivery/use-mobile-native-chat-send-error'
import { mobileNativeChatScopeKey } from './native-chat/conversation/mobile-native-chat-scope-key'
import { mobileNativeChatOverlayInputLockReason } from './native-chat/status/mobile-native-chat-overlay-lock-reason'
import { useMobileSendCompletionGeneration } from './use-mobile-send-completion-generation'
import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'

export function useMobileSessionNativeChatDictation(
  scope: MobileSessionFeedbackCapabilitiesModel,
  sendLiveTerminalInput: (handle: string, bytes: string) => Promise<boolean>,
  itemLink?: MobileSessionItemLink
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
  const nativeChatController = useMobileNativeChatController({
    itemLink,
    client,
    pairedHostClient,
    hostCapabilities: scope.hostCapabilities,
    hostId,
    worktreeId,
    activeSessionTab,
    activeSessionTabId,
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

  const executionHost = useWorkspaceExecutionHost()
  const paneKey = sessionTabPaneKey(activeSessionTab)
  const sessionDictation = useMobileScreenDictation(
    scope,
    nativeChatController,
    sendLiveTerminalInput,
    {
      key: JSON.stringify([hostId, executionHost ?? null, worktreeId]),
      name: HOST_SESSION_ROUTE,
      title: activeSessionTab?.title ?? '',
      paneKey,
      href: workspaceRouteHref(
        `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(worktreeId)}${paneKey ? `?paneKey=${encodeURIComponent(paneKey)}` : ''}`,
        executionHost
      )
    }
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
