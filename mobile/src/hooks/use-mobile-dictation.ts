import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useDictationCapture } from '../platform/dictation-capture'
import { useOnDeviceSpeech } from '../platform/on-device-speech'
import { dictationSessionErrorMessage } from '../dictation/mobile-dictation-setup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileDictationMeter } from './mobile-dictation-meter'
import { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'
import {
  useMobileDictationTranscriptSoFar,
  subscribeMobileDictationAudioChunks,
  type MobileDictationAudioPhase
} from './mobile-dictation-audio-chunk'
import { MobileDictationHeldAudio } from './mobile-dictation-held-audio'
import { isCurrentMobileDictationFinish } from './mobile-dictation-session-state'
import { finishDesktopDictation } from './mobile-dictation-desktop-start'
import type { MobileDictationEngine } from './mobile-dictation-device-engine'
import {
  finishMobileDictationOnDevice,
  releaseMobileDictationEngine,
  settleMobileDictation,
  startMobileDictation,
  type MobileDictationRun
} from './mobile-dictation-engine-run'
import { rpcPayloadMember } from '../transport/rpc/rpc-reader-payload'
import type {
  DictationStatus,
  UseMobileDictationOptions,
  UseMobileDictationResult
} from './mobile-dictation-session-state'

export type { UseMobileDictationResult } from './mobile-dictation-session-state'

export function useMobileDictation(options: UseMobileDictationOptions): UseMobileDictationResult {
  useMobileTranslation()
  const { client, enabled, onTranscript, onError, removeFillerWords } = options
  // Both capture seams hold the screen while the microphone is open; native uses the device directly and page uses shell audio verbs.
  const capture = useDictationCapture()
  const speech = useOnDeviceSpeech(removeFillerWords)
  const [status, setStatus] = useState<DictationStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [transcriptSoFar, setTranscriptSoFar, keptTranscript] = useMobileDictationTranscriptSoFar()
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
  const pendingChunksRef = useRef<Set<Promise<void>>>(new Set())
  const pendingAudioBudgetRef = useRef(new MobileDictationPendingAudioBudget())
  const audioPhaseRef = useRef<MobileDictationAudioPhase>('closed')
  const heldAudioRef = useRef(new MobileDictationHeldAudio())
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
  }, [client, speech, enabled, onTranscript, onError])

  const applyStatus = useCallback((next: DictationStatus) => {
    statusRef.current = next
    setStatus(next)
    // Kept through processing so the text so far stays in place until the final transcript replaces it in the same render.
    setTranscriptSoFar((text) => (next === 'recording' || next === 'processing' ? text : ''))
  }, [])

  const reportError = useCallback(
    (err: unknown) => {
      const normalized = err instanceof Error ? err : new Error(String(err))
      setError(normalized.message)
      applyStatus('error')
      onErrorRef.current?.(normalized)
    },
    [applyStatus]
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

  const failActiveDictation = useCallback(
    (dictationId: string, err: unknown) => {
      if (activeIdRef.current !== dictationId) {
        return
      }
      activeIdRef.current = null
      closeDictationAudio()
      void releaseMobileDictationEngine(
        { engine: engineRef, speech: speechRef },
        clientRef.current,
        dictationId
      )
      const kept = keptTranscript.take(dictationId)
      if (kept) {
        onTranscriptRef.current(kept)
      }
      reportError(err)
    },
    [closeDictationAudio, reportError]
  )

  const run = useMemo<MobileDictationRun>(
    () => ({
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
      sendHeldAudio: sendHeldAudioRef,
      finish: finishRef,
      onTranscript: onTranscriptRef,
      keptTranscript,
      applyStatus,
      closeDictationAudio,
      reportError,
      failActiveDictation
    }),
    [applyStatus, closeDictationAudio, failActiveDictation, keptTranscript, reportError]
  )

  useEffect(() => {
    const source = {
      getClient: () => clientRef.current,
      getActiveId: () => activeIdRef.current,
      audioPhase: () => (enabledRef.current ? audioPhaseRef.current : 'closed')
    }
    const sub = subscribeMobileDictationAudioChunks(capture, source, {
      pendingChunks: pendingChunksRef.current,
      pendingAudioBudget: pendingAudioBudgetRef.current,
      failActiveDictation,
      transcriptSoFar: keptTranscript,
      heldAudio: heldAudioRef.current
    })
    sendHeldAudioRef.current = sub.sendHeld
    return () => sub.remove()
  }, [capture, failActiveDictation])

  const finishDictation = useCallback(
    async (emptyTranscriptMessage: string) => {
      const client = clientRef.current
      const dictationId = activeIdRef.current
      const engine = engineRef.current
      if (!dictationId || (engine.kind === 'host' && !client)) {
        return
      }
      // A fallback's host start is still pending: finish once it commits and the kept audio has gone.
      if (engine.kind === 'host' && audioPhaseRef.current === 'holding') {
        stopWhenStartedRef.current = true
        if (statusRef.current === 'recording') {
          applyStatus('processing')
          // Stop listening now; the tail joins the held audio the replay sends.
          void capture.end()
        }
        return
      }

      const generation = generationRef.current + 1
      generationRef.current = generation
      applyStatus('processing')
      const isCurrent = () =>
        isCurrentMobileDictationFinish(
          generationRef.current,
          generation,
          enabledRef.current,
          activeIdRef.current,
          dictationId
        )
      try {
        // Keep shutdown inside try for finally cleanup; accept its tail chunks and snapshot pending sends only after end settles, or finish can overtake the last audio.
        await capture.end()
        if (engine.kind === 'device') {
          await finishMobileDictationOnDevice(
            run,
            engine,
            dictationId,
            emptyTranscriptMessage,
            isCurrent
          )
          return
        }
        audioPhaseRef.current = 'closed'
        await Promise.allSettled(Array.from(pendingChunksRef.current))
        if (!isCurrent() || !client) {
          return
        }
        const finished = await finishDesktopDictation(client, dictationId)
        if (!isCurrent()) {
          return
        }
        const transcript = rpcPayloadMember(finished, 'text')
        settleMobileDictation(
          run,
          typeof transcript === 'string' ? transcript.trim() : '',
          emptyTranscriptMessage
        )
      } catch (err) {
        failActiveDictation(dictationId, err)
      }
    },
    [applyStatus, capture, failActiveDictation, run]
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

  const start = useCallback(async () => {
    if ((!clientRef.current && !speechRef.current) || !enabledRef.current || activeIdRef.current) {
      return
    }
    setError(null)
    await startMobileDictation(run, capture)
  }, [capture, run])

  // Only the user’s own cancel (reason:null) ends silently; other interruptions call onError so the tap has a visible outcome.
  const abandonDictation = useCallback(
    async (reason: string | null) => {
      const client = clientRef.current
      const dictationId = activeIdRef.current
      const wasUnderway = statusRef.current === 'starting' || statusRef.current === 'recording'
      generationRef.current += 1
      activeIdRef.current = null
      closeDictationAudio()
      // Settle before the host's cancel reply: a host that went quiet must not hold the mic button in its old state.
      if (reason !== null && wasUnderway) {
        reportError(new Error(reason))
      } else {
        applyStatus('idle')
        setError(null)
      }
      await releaseMobileDictationEngine(run, client, dictationId)
    },
    [applyStatus, closeDictationAudio, reportError, run]
  )

  const cancel = useCallback(() => abandonDictation(null), [abandonDictation])

  useEffect(() => {
    // Finish what was already streamed; only the user's own cancel may discard it.
    const interrupted = () => {
      if (statusRef.current === 'recording') {
        void finishDictation(dictationSessionErrorMessage('interrupted'))
      } else if (audioPhaseRef.current === 'holding') {
        // The mic is live while the host start is pending: close it now, and finish with what it heard once the start commits.
        stopWhenStartedRef.current = true
        applyStatus('processing')
        void capture.end()
      } else if (statusRef.current === 'starting') {
        void abandonDictation(dictationSessionErrorMessage('interrupted'))
      }
    }
    const sub = capture.onInterruption(interrupted)
    // A backgrounded app loses the microphone, so leaving finishes. Not before the mic opens: Android's permission prompt reports background.
    const appState = AppState.addEventListener('change', (state) => {
      if (
        state === 'background' &&
        (statusRef.current === 'recording' || audioPhaseRef.current === 'holding')
      ) {
        interrupted()
      }
    })
    return () => {
      sub.remove()
      appState.remove()
    }
  }, [abandonDictation, applyStatus, capture, finishDictation])

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
    start,
    stop,
    cancel,
    meter: useMobileDictationMeter(capture, status === 'recording')
  }
}
