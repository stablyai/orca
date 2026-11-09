import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDictationCapture } from '../platform/dictation-capture'
import { useOnDeviceSpeech } from '../platform/on-device-speech'
import { dictationSessionErrorMessage } from '../dictation/mobile-dictation-setup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileDictationMeter } from './mobile-dictation-meter'
import { useMobileDictationEngineShown } from './mobile-dictation-engine-shown'
import { useMobileDictationInterruptions } from './use-mobile-dictation-interruptions'
import { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'
import {
  useMobileDictationTranscriptSoFar,
  useMobileDictationAudioChunks,
  type MobileDictationAudioPhase
} from './mobile-dictation-audio-chunk'
import { MobileDictationHeldAudio } from './mobile-dictation-held-audio'
import { MobileDictationRecording } from './mobile-dictation-recording'
import { failActiveMobileDictation, retryMobileDictationOnHost } from './mobile-dictation-retry'
import { mobileDictationFailureRetryable } from './mobile-dictation-failure'
import { finishMobileDictation } from './mobile-dictation-finish'
import type { MobileDictationEngine } from './mobile-dictation-device-engine'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  releaseMobileDictationEngine,
  startMobileDictation,
  type MobileDictationRun
} from './mobile-dictation-engine-run'
import type {
  DictationStatus,
  MobileDictationKeptFailure,
  UseMobileDictationOptions,
  UseMobileDictationResult
} from './mobile-dictation-session-state'

export type { UseMobileDictationResult } from './mobile-dictation-session-state'

export function useMobileDictation(options: UseMobileDictationOptions): UseMobileDictationResult {
  useMobileTranslation()
  const { client, enabled, onTranscript, onError, removeFillerWords, onAudioLimitReached } = options
  // Both capture seams hold the screen while the microphone is open; native uses the device directly and page uses shell audio verbs.
  const capture = useDictationCapture()
  const speech = useOnDeviceSpeech(removeFillerWords)
  const [status, setStatus] = useState<DictationStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  // A failure whose recording is kept for Retry; cleared by Retry, discard and the next dictation.
  const [failure, setFailure] = useState<MobileDictationKeptFailure | null>(null)
  const failureRef = useRef(failure)
  const [transcriptSoFar, setTranscriptSoFar, keptTranscript] = useMobileDictationTranscriptSoFar()
  const {
    shown: shownEngine,
    show: showEngine,
    clear: clearEngine
  } = useMobileDictationEngineShown()
  // Read from an abort that may run between a commit and its passive Effects, where state is stale.
  const statusRef = useRef<DictationStatus>('idle')
  const activeIdRef = useRef<string | null>(null)
  const clientRef = useRef(client)
  const speechRef = useRef(speech)
  const engineRef = useRef<MobileDictationEngine>({ kind: 'host' })
  const finishRef = useRef<(emptyTranscriptMessage: string) => Promise<void>>(async () => {})
  const enabledRef = useRef(enabled)
  const onTranscriptRef = useRef(onTranscript)
  const onErrorRef = useRef(onError)
  const onAudioLimitReachedRef = useRef(onAudioLimitReached)
  const pendingChunksRef = useRef<Set<Promise<void>>>(new Set())
  const pendingAudioBudgetRef = useRef(new MobileDictationPendingAudioBudget())
  const audioPhaseRef = useRef<MobileDictationAudioPhase>('closed')
  const heldAudioRef = useRef(new MobileDictationHeldAudio())
  const recordingRef = useRef(new MobileDictationRecording())
  const sendHeldAudioRef = useRef(() => {})
  const stopWhenStartedRef = useRef(false)
  const generationRef = useRef(0)

  useLayoutEffect(() => {
    // Native audio events can arrive before passive Effects flush, but refs
    // should only expose options from a committed render.
    clientRef.current = client
    speechRef.current = speech
    enabledRef.current = enabled
    onTranscriptRef.current = onTranscript
    onErrorRef.current = onError
    onAudioLimitReachedRef.current = onAudioLimitReached
  }, [client, speech, enabled, onTranscript, onError, onAudioLimitReached])

  const applyStatus = useCallback(
    // Kept through processing so the text so far stays in place until the final transcript replaces it in the same render.
    (next: DictationStatus, keepText = next === 'recording' || next === 'processing') => {
      statusRef.current = next
      setStatus(next)
      setTranscriptSoFar((text) => (keepText ? text : ''))
      if (next !== 'recording' && next !== 'processing') {
        clearEngine()
      }
    },
    [clearEngine]
  )

  const setKeptFailure = useCallback((next: MobileDictationKeptFailure | null) => {
    failureRef.current = next
    setFailure(next)
  }, [])

  const reportError = useCallback(
    (err: unknown, kept = false) => {
      const normalized = err instanceof Error ? err : new Error(String(err))
      setError(normalized.message)
      applyStatus('error', kept)
      setKeptFailure(
        kept
          ? { message: normalized.message, offline: clientRef.current?.getState() !== 'connected' }
          : null
      )
      onErrorRef.current?.(normalized, { kept })
    },
    [applyStatus, setKeptFailure]
  )

  const closeDictationAudio = useCallback(() => {
    audioPhaseRef.current = 'closed'
    heldAudioRef.current.clear()
    pendingChunksRef.current.clear()
    pendingAudioBudgetRef.current.reset()
    try {
      void capture.end()
    } catch (err) {
      // Cleanup must keep going when a synchronous seam throws, or the dictation state would leak.
      console.error('Failed to stop microphone recording', err)
    }
  }, [capture])

  const run = useMemo<MobileDictationRun>(() => {
    const created: MobileDictationRun = {
      status: statusRef,
      activeId: activeIdRef,
      client: clientRef,
      speech: speechRef,
      engine: engineRef,
      enabled: enabledRef,
      generation: generationRef,
      stopWhenStarted: stopWhenStartedRef,
      audioPhase: audioPhaseRef,
      pendingChunks: pendingChunksRef,
      pendingAudioBudget: pendingAudioBudgetRef,
      heldAudio: heldAudioRef,
      recording: recordingRef,
      sendHeldAudio: sendHeldAudioRef,
      finish: finishRef,
      onTranscript: onTranscriptRef,
      onAudioLimitReached: onAudioLimitReachedRef,
      keptTranscript,
      applyStatus,
      showEngine,
      closeDictationAudio,
      reportError,
      failActiveDictation: (dictationId, err) =>
        failActiveMobileDictation(created, dictationId, err)
    }
    return created
  }, [applyStatus, closeDictationAudio, keptTranscript, reportError, showEngine])

  useMobileDictationAudioChunks(capture, run)

  const finishDictation = useCallback(
    (emptyTranscriptMessage: string) => finishMobileDictation(run, capture, emptyTranscriptMessage),
    [capture, run]
  )
  useLayoutEffect(() => {
    finishRef.current = finishDictation
  }, [finishDictation])

  const stop = useCallback(async () => {
    // Speech is held from the tap, so a stop before the host answers finishes once it does.
    if (statusRef.current === 'starting') {
      stopWhenStartedRef.current = true
      return
    }
    await finishDictation(dictationSessionErrorMessage('no-speech'))
  }, [finishDictation])

  const start = useCallback(
    async (startClient?: RpcClient | null) => {
      // The caller's client, set before the next render commits it: one hook serves whichever session starts.
      if (startClient !== undefined) {
        clientRef.current = startClient
      }
      if (
        (!clientRef.current && !speechRef.current) ||
        !enabledRef.current ||
        activeIdRef.current
      ) {
        return
      }
      setError(null)
      // A new dictation replaces a failed one's kept recording.
      setKeptFailure(null)
      recordingRef.current.clear()
      await startMobileDictation(run, capture)
    },
    [capture, run, setKeptFailure]
  )

  const retry = useCallback(async () => {
    const client = clientRef.current
    if (!failureRef.current || !client || activeIdRef.current || !enabledRef.current) {
      return
    }
    setError(null)
    setKeptFailure(null)
    await retryMobileDictationOnHost(run, client)
  }, [run, setKeptFailure])

  // Only the user’s own cancel (reason:null) ends silently; other interruptions call onError so the tap has a visible outcome.
  const abandonDictation = useCallback(
    async (reason: string | null) => {
      const client = clientRef.current
      const dictationId = activeIdRef.current
      const wasUnderway = statusRef.current === 'starting' || statusRef.current === 'recording'
      // Only the user's discard drops a kept recording; an interruption while it waits leaves it for Retry.
      if (reason !== null && dictationId === null && failureRef.current) {
        return
      }
      // An interruption keeps a recording the computer can hear again, even mid-finish; the user's cancel never does.
      const kept =
        reason !== null &&
        dictationId !== null &&
        mobileDictationFailureRetryable(recordingRef.current, engineRef.current)
      if (!kept) {
        setKeptFailure(null)
        recordingRef.current.clear()
      }
      generationRef.current += 1
      activeIdRef.current = null
      closeDictationAudio()
      // Settle before the host's cancel reply: a host that went quiet must not hold the mic button in its old state.
      if (kept) {
        reportError(new Error(reason), true)
      } else if (reason !== null && wasUnderway) {
        reportError(new Error(reason))
      } else {
        applyStatus('idle')
        setError(null)
      }
      await releaseMobileDictationEngine(run, client, dictationId)
    },
    [applyStatus, closeDictationAudio, reportError, run, setKeptFailure]
  )

  const cancel = useCallback(() => abandonDictation(null), [abandonDictation])

  useMobileDictationInterruptions({
    capture,
    status: statusRef,
    audioPhase: audioPhaseRef,
    stopWhenStarted: stopWhenStartedRef,
    applyStatus,
    finish: finishDictation,
    abandon: abandonDictation
  })

  useEffect(() => {
    if (!enabled) {
      void abandonDictation(dictationSessionErrorMessage('input-closed'))
    }
  }, [abandonDictation, enabled])

  useEffect(() => {
    return () => {
      const dictationId = activeIdRef.current
      generationRef.current += 1
      activeIdRef.current = null
      closeDictationAudio()
      recordingRef.current.clear()
      capture.release()
      void releaseMobileDictationEngine(run, clientRef.current, dictationId)
    }
  }, [capture, closeDictationAudio, run])

  return {
    status,
    isStarting: status === 'starting',
    isRecording: status === 'recording',
    isProcessing: status === 'processing',
    transcriptSoFar,
    error,
    failure,
    engine: shownEngine,
    start,
    retry,
    stop,
    cancel,
    meter: useMobileDictationMeter(capture, status === 'recording')
  }
}
