import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useMobileSessionDictationSetup } from './use-mobile-session-dictation-setup'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { triggerError } from '../platform/haptics'
import { useClipboardWriter } from '../platform/clipboard'
import {
  useMobileDictationDestination,
  useMobileDictationPreviews
} from '../dictation/use-mobile-dictation-destination'
import {
  dictationFailureMessage,
  isDictationSetupRequiredError
} from '../dictation/mobile-dictation-setup'
import { useMobileDictationLeaveHold } from '../dictation/mobile-dictation-leave-hold'
import { useMobileDictationHost } from '../dictation/mobile-dictation-host'
import { mobileDictationShownOnScreen } from '../dictation/mobile-dictation-shown'
import { nativeChatDictationCopy } from '../dictation/mobile-session-native-chat-dictation-copy'
import {
  useWorkspaceExecutionHost,
  workspaceRouteHref
} from '../navigation/workspace-execution-host'
import { mobileSessionTabPaneKey } from './tabs/notification-pane-tab'
import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'
import type { useMobileNativeChatController } from './native-chat/use-mobile-native-chat-controller'

// What a session screen's controls see when the dictation belongs to another screen, or this one is behind another.
function idleView(dictation: UseMobileDictationResult): UseMobileDictationResult {
  return {
    ...dictation,
    status: 'idle',
    isStarting: false,
    isRecording: false,
    isProcessing: false,
    transcriptSoFar: '',
    error: null,
    failure: null,
    engine: null
  }
}

function isUnderway(dictation: UseMobileDictationResult): boolean {
  return (
    dictation.isStarting ||
    dictation.isRecording ||
    dictation.isProcessing ||
    dictation.failure !== null
  )
}

// The session screen's side of the page's one dictation: start it here, show it in place while this screen is in front, and insert where it started.
export function useMobileSessionDictation(
  scope: MobileSessionFeedbackCapabilitiesModel,
  nativeChatController: ReturnType<typeof useMobileNativeChatController>,
  sendLiveTerminalInput: (handle: string, bytes: string) => Promise<boolean>
) {
  const {
    hostId,
    worktreeId,
    client,
    connState,
    activeHandle,
    activeHandleRef,
    activeSessionTab,
    setShowDictationSetup,
    deviceTokenRef,
    dictationRouteContextRef,
    flushPendingLiveInputBeforeExternalSend,
    canSend,
    showToast,
    router
  } = scope
  const { showNativeChat, showNativeChatRef } = nativeChatController
  const host = useMobileDictationHost()
  const executionHost = useWorkspaceExecutionHost()
  const sessionKey = JSON.stringify([hostId, executionHost ?? null, worktreeId])
  const [instance] = useState(() => ({}))
  const [inFront, setInFront] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setInFront(true)
      return () => setInFront(false)
    }, [])
  )
  const shown = mobileDictationShownOnScreen({
    ownedHere: host.owner?.sessionKey === sessionKey,
    inFront
  })
  const raw = host.dictation
  const dictation = useMemo(() => (shown ? raw : idleView(raw)), [raw, shown])
  const busyElsewhere = !shown && isUnderway(raw)

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
  // Chat dictation is inserted locally; a terminal's words are typed into it live, while it is the active one.
  const insertHere = (text: string): boolean => {
    if (destination.landsInChat(showNativeChatRef.current)) {
      if (!destination.insertInChat(text)) {
        keepUndeliveredDictation(text)
      }
      return true
    }
    const routeContext = dictationRouteContextRef.current
    const insertHandle = routeContext?.handle ?? activeHandleRef.current
    // Another terminal is in front: the host types the words into the one the dictation started in.
    if (insertHandle === null || insertHandle !== activeHandleRef.current) {
      return false
    }
    dictationRouteContextRef.current = null
    void (async () => {
      const sent =
        (await flushPendingLiveInputBeforeExternalSend(insertHandle)) &&
        (await sendLiveTerminalInput(insertHandle, text))
      // Live input lands in a terminal the keyboard may cover, so say where the words went.
      if (sent) {
        showToast(nativeChatDictationCopy.inserted())
      } else {
        keepUndeliveredDictation(text)
      }
    })().catch(() => keepUndeliveredDictation(text))
    return true
  }

  const screenRef = useRef({
    shown,
    insert: insertHere,
    reportFailure: reportDictationFailure,
    showToast
  })
  useLayoutEffect(() => {
    screenRef.current = {
      shown,
      insert: insertHere,
      reportFailure: reportDictationFailure,
      showToast
    }
  })
  const { attach, refresh } = host
  useEffect(
    () =>
      attach({
        instance,
        sessionKey,
        shown: () => screenRef.current.shown,
        insert: (text) => screenRef.current.insert(text),
        reportFailure: (err) => {
          dictationRouteContextRef.current = null
          screenRef.current.reportFailure(err)
        },
        toast: (message) => screenRef.current.showToast(message)
      }),
    [attach, dictationRouteContextRef, instance, sessionKey]
  )
  // The pill reads shown() on the host's render.
  useEffect(() => refresh(), [refresh, shown])

  const {
    phoneDictation,
    removeFillerWords,
    dictationNeedsSetupRef,
    closeDictationSetup,
    refreshDictationMode
  } = useMobileSessionDictationSetup(scope)
  // Starting needs the host (unless the phone hears chat itself), but a reconnect must not end a recording: the host keeps the session through it.
  const dictationCanStart = showNativeChat
    ? connState === 'connected' || phoneDictation.ready
    : canSend

  const dictationLeaveHold = useMobileDictationLeaveHold(dictation, () => router.canGoBack())
  const previews = useMobileDictationPreviews(destination, dictation, activeHandle)

  const startDictation = useCallback(() => {
    if (busyElsewhere) {
      // One dictation per phone: the pill for the other one is on screen.
      triggerError()
      return
    }
    if (!dictationCanStart) {
      return
    }
    if (dictationNeedsSetupRef.current && !phoneDictation.readyRef.current) {
      // Explain setup before the OS microphone prompt: mic access cannot help until the host can transcribe.
      setShowDictationSetup(true)
      return
    }
    const routeContext = activeHandle ? { handle: activeHandle } : null
    dictationRouteContextRef.current = routeContext
    const target = destination.captureDestination(showNativeChat, activeHandle)
    const paneKey = mobileSessionTabPaneKey(activeSessionTab)
    void host
      .start({
        instance,
        sessionKey,
        client,
        deviceToken: deviceTokenRef.current,
        target:
          target?.field === 'chat'
            ? target.scope === null
              ? null
              : { field: 'chat', scope: target.scope }
            : target,
        title: activeSessionTab?.title ?? '',
        href: workspaceRouteHref(
          `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(worktreeId)}${paneKey ? `?paneKey=${encodeURIComponent(paneKey)}` : ''}`,
          executionHost
        ),
        dictationMode: scope.dictationMode,
        removeFillerWords
      })
      .catch((err) => {
        if (dictationRouteContextRef.current === routeContext) {
          dictationRouteContextRef.current = null
        }
        reportDictationFailure(err)
      })
  }, [
    activeHandle,
    activeSessionTab,
    busyElsewhere,
    client,
    destination.captureDestination,
    deviceTokenRef,
    dictationCanStart,
    dictationRouteContextRef,
    executionHost,
    host,
    hostId,
    instance,
    phoneDictation.readyRef,
    removeFillerWords,
    reportDictationFailure,
    scope.dictationMode,
    sessionKey,
    setShowDictationSetup,
    showNativeChat,
    worktreeId
  ])

  const stopDictation = host.stop
  const cancelDictation = useCallback(() => {
    dictationRouteContextRef.current = null
    void raw.cancel()
  }, [dictationRouteContextRef, raw])

  const handleDictationToggle = useCallback(() => {
    if (dictation.isProcessing) {
      // Ignore toggles until finish settles; a tap must not discard what was said.
    } else if (dictation.isStarting || dictation.isRecording) {
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
    // Speech is held from the press, so a release while starting finishes once the host answers.
    if (dictation.isStarting || dictation.isRecording) {
      stopDictation()
    }
  }, [dictation, stopDictation])

  return {
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
