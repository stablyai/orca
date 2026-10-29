import { useEffect, useCallback, useRef } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { useMobileDictation } from '../hooks/use-mobile-dictation'
import { triggerError } from '../platform/haptics'
import { useClipboardWriter } from '../platform/clipboard'
import { routeDictationTranscript } from '../terminal/terminal-live-dictation-routing'
import { insertDictationText } from '../dictation/mobile-dictation-text-insertion'
import {
  dictationRouteContextFor,
  useMobileDictationDestination,
  useMobileDictationPreviews
} from './use-mobile-dictation-destination'
import {
  dictationFailureMessage,
  dictationMicHidden,
  dictationNeedsSetup,
  fetchDictationSetup,
  isDictationSetupRequiredError
} from '../dictation/mobile-dictation-setup'
import { useMobileNativeChatController } from './use-mobile-native-chat-controller'
import { useMobileDictationLeaveHold } from './mobile-dictation-leave-hold'
import { useMobileDictationHaptics } from './use-mobile-dictation-haptics'
import { useMobileNativeChatReadability } from './use-mobile-native-chat-readability'
import { useMobileNativeChatInputLease } from './native-chat/use-mobile-native-chat-input-lease'
import { useMobileNativeChatSendError } from './native-chat/use-mobile-native-chat-send-error'
import { mobileNativeChatScopeKey } from './native-chat/mobile-native-chat-scope-key'
import { isMobileNativeChatAgentConfirmed } from './native-chat/mobile-native-chat-eligibility'
import { useMobileSendCompletionGeneration } from './use-mobile-send-completion-generation'
import { nativeChatDictationCopy } from './mobile-session-native-chat-dictation-copy'
import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'

export function useMobileSessionNativeChatDictation(
  scope: MobileSessionFeedbackCapabilitiesModel,
  sendLiveTerminalInput: (handle: string, bytes: string) => Promise<boolean>
) {
  const {
    hostId,
    worktreeId,
    client,
    connState,
    agentSessionHostSupport,
    setInput,
    liveInputTerminalHandles,
    activeHandle,
    activeSessionTabId,
    diffComments,
    diffCommentsRef,
    setShowDictationSetup,
    setDictationMode,
    dictationEnabled,
    setDictationEnabled,
    deviceTokenRef,
    dictationRouteContextRef,
    commandFieldAnchorRef,
    activeHandleRef,
    activeSessionTab,
    flushPendingLiveInputBeforeExternalSend,
    canSend,
    canCompose,
    liveInputEnabled,
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
    client,
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
  const nativeChatOverlayInputLockReason =
    activeSessionTab?.type === 'agent-session'
      ? connState === 'connected'
        ? null
        : 'disconnected'
      : // Why: a chat only this phone remembers may sit on a bare shell; never type into it.
        (nativeChatInputLockReason ??
        (isMobileNativeChatAgentConfirmed(activeSessionTab) ? null : 'waiting'))
  const routeKey = nativeChatScopeKey ?? `${hostId}\0${worktreeId}`
  const getSendCompletionGeneration = useMobileSendCompletionGeneration({
    onBlur: resetLiveInputFocus,
    surfaceKey: JSON.stringify([routeKey, activeHandle, showNativeChat, liveInputEnabled])
  })

  // Share dictation error handling for start rejection and live errors so disabled host setup always opens the setup sheet.
  const reportDictationFailure = useCallback(
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (isDictationSetupRequiredError(message)) {
        setShowDictationSetup(true)
        return
      }
      triggerError()
      showToast(dictationFailureMessage(message))
    },
    [setShowDictationSetup, showToast]
  )

  const clipboard = useClipboardWriter()
  // A transcript its target refused must not vanish: keep it on the clipboard and say so.
  const keepUndeliveredDictation = (text: string) => {
    triggerError()
    void clipboard.writeText(text).then(
      () => showToast(nativeChatDictationCopy.insertFailedCopied()),
      () => showToast(nativeChatDictationCopy.insertFailed())
    )
  }

  const destination = useMobileDictationDestination(nativeChatController)
  // Starting needs the host, but a reconnect must not end a recording: the host keeps the session through it.
  const dictationCanStart = showNativeChat ? connState === 'connected' : canSend
  const dictation = useMobileDictation({
    client,
    enabled: (showNativeChat || canCompose) && dictationEnabled,
    onTranscript: (text) => {
      // Chat dictation is inserted locally; terminal mode retains live-input routing.
      if (destination.landsInChat(showNativeChatRef.current)) {
        if (!destination.insertInChat(text)) {
          keepUndeliveredDictation(text)
        }
        return
      }
      const routeContext = dictationRouteContextRef.current
      dictationRouteContextRef.current = null
      const route = routeDictationTranscript(
        text,
        routeContext?.liveInputEnabled ?? liveInputEnabled
      )
      if (route.kind === 'live-insert') {
        const insertHandle = routeContext?.handle ?? activeHandleRef.current
        void (async () => {
          const sent =
            insertHandle !== null &&
            (await flushPendingLiveInputBeforeExternalSend(insertHandle)) &&
            (await sendLiveTerminalInput(insertHandle, route.text))
          // Live input lands in a terminal the keyboard may cover; the visible fields need no receipt.
          if (sent) {
            showToast(nativeChatDictationCopy.inserted())
          } else {
            keepUndeliveredDictation(route.text)
          }
        })().catch(() => keepUndeliveredDictation(route.text))
        return
      }
      // The draft written is the active terminal's; a selection read in another terminal only appends there.
      const anchor = routeContext?.handle === activeHandleRef.current ? routeContext.anchor : null
      setInput((current) => insertDictationText(current, route.text, anchor).text)
    },
    onError: (err) => {
      dictationRouteContextRef.current = null
      reportDictationFailure(err)
    }
  })

  const dictationLeaveHold = useMobileDictationLeaveHold(dictation)
  const previews = useMobileDictationPreviews(destination, dictation, activeHandle)

  // Only a host setup read sets this; while false, the host's start refusal decides (older hosts, first tap before the read).
  const dictationNeedsSetupRef = useRef(false)

  const startDictation = useCallback(() => {
    if (!dictationCanStart) {
      return
    }
    if (dictationNeedsSetupRef.current) {
      // Explain setup before the OS microphone prompt: mic access cannot help until the host can transcribe.
      setShowDictationSetup(true)
      return
    }
    const routeContext = dictationRouteContextFor(
      activeHandle,
      liveInputTerminalHandles,
      commandFieldAnchorRef.current
    )
    dictationRouteContextRef.current = routeContext
    destination.captureDestination(showNativeChat, routeContext)
    void dictation.start().catch((err) => {
      if (dictationRouteContextRef.current === routeContext) {
        dictationRouteContextRef.current = null
      }
      reportDictationFailure(err)
    })
  }, [
    activeHandle,
    destination.captureDestination,
    dictation,
    dictationCanStart,
    liveInputTerminalHandles,
    reportDictationFailure,
    setShowDictationSetup,
    showNativeChat
  ])

  const stopDictation = useMobileDictationHaptics(dictation)

  const cancelDictation = useCallback(() => {
    dictationRouteContextRef.current = null
    void dictation.cancel()
  }, [dictation])

  const handleDictationToggle = useCallback(() => {
    if (dictation.isStarting || dictation.isProcessing) {
      // Ignore toggles until start or finish settles; a tap must not discard what was said.
    } else if (dictation.isRecording) {
      stopDictation()
    } else {
      startDictation()
    }
  }, [dictation, startDictation, stopDictation])

  const handleDictationPressIn = useCallback(() => {
    if (!dictation.isStarting && !dictation.isRecording && !dictation.isProcessing) {
      startDictation()
    }
  }, [dictation, startDictation])

  const handleDictationPressOut = useCallback(() => {
    if (dictation.isRecording) {
      stopDictation()
    } else if (dictation.isStarting) {
      // Released before recording began: cancel so we don't leave a live mic.
      cancelDictation()
    }
  }, [cancelDictation, dictation, stopDictation])

  const dictationSettingsReadRef = useRef(0)
  const refreshDictationMode = useCallback(async () => {
    const read = ++dictationSettingsReadRef.current
    if (!client || connState !== 'connected') {
      return
    }
    try {
      const setup = await fetchDictationSetup(client)
      if (read === dictationSettingsReadRef.current) {
        setDictationMode(setup.dictationMode)
        setDictationEnabled(!dictationMicHidden(setup))
        dictationNeedsSetupRef.current = dictationNeedsSetup(setup)
      }
    } catch {
      // Keep the last settings when an older host cannot report them.
    }
  }, [client, connState, setDictationEnabled, setDictationMode])

  // The sheet may have changed host setup: let the host judge taps until the fresh read lands.
  const closeDictationSetup = useCallback(() => {
    setShowDictationSetup(false)
    dictationNeedsSetupRef.current = false
    void refreshDictationMode()
  }, [refreshDictationMode, setShowDictationSetup])

  useFocusEffect(
    useCallback(() => {
      void refreshDictationMode()
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          void refreshDictationMode()
        }
      })
      return () => {
        // Late replies from a retired connection or focus must not rebind the mic.
        dictationSettingsReadRef.current += 1
        subscription.remove()
      }
    }, [refreshDictationMode])
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
    dictation,
    dictationLeaveHold,
    ...previews,
    startDictation,
    cancelDictation,
    handleDictationToggle,
    handleDictationPressIn,
    handleDictationPressOut,
    closeDictationSetup,
    refreshDictationMode
  }
}

export type MobileSessionNativeChatDictationModel = MobileSessionFeedbackCapabilitiesModel &
  ReturnType<typeof useMobileSessionNativeChatDictation>
