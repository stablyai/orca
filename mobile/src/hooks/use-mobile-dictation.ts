import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDictationCapture } from '../platform/dictation-capture'
import { dictationSessionErrorMessage } from '../dictation/mobile-dictation-setup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileDictationMeter } from './mobile-dictation-meter'
import { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'
import {
  useMobileDictationTranscriptSoFar,
  subscribeMobileDictationAudioChunks,
  type MobileDictationAudioPhase
} from './mobile-dictation-audio-chunk'
import { MobileDictationStartBuffer } from './mobile-dictation-start-buffer'
import { openMobileDictationCapture } from './mobile-dictation-capture-open'
import {
  createMobileDictationId,
  isCurrentMobileDictationFinish
} from './mobile-dictation-session-state'
import {
  cancelDesktopDictation,
  finishDesktopDictation,
  settledDesktopDictationWork,
  startMobileDictationDesktopSession
} from './mobile-dictation-desktop-start'
import { rpcPayloadMember } from '../transport/rpc-reader-payload'
import type {
  DictationStatus,
  UseMobileDictationOptions,
  UseMobileDictationResult
} from './mobile-dictation-session-state'

export type { UseMobileDictationResult } from './mobile-dictation-session-state'

export function useMobileDictation(options: UseMobileDictationOptions): UseMobileDictationResult {
  useMobileTranslation()
  const { client, enabled, onTranscript, onError } = options
  // Both capture seams hold the screen while the microphone is open; native uses the device directly and page uses shell audio verbs.
  const capture = useDictationCapture()
  const [status, setStatus] = useState<DictationStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [transcriptSoFar, setTranscriptSoFar, keptTranscript] = useMobileDictationTranscriptSoFar()
  // Read from an abort that may run between a commit and its passive Effects, where state is stale.
  const statusRef = useRef<DictationStatus>('idle')
  const activeIdRef = useRef<string | null>(null)
  const clientRef = useRef(client)
  const enabledRef = useRef(enabled)
  const onTranscriptRef = useRef(onTranscript)
  const onErrorRef = useRef(onError)
  const pendingChunksRef = useRef<Set<Promise<void>>>(new Set())
  const pendingAudioBudgetRef = useRef(new MobileDictationPendingAudioBudget())
  const audioPhaseRef = useRef<MobileDictationAudioPhase>('closed')
  const startBufferRef = useRef(new MobileDictationStartBuffer())
  const sendHeldAudioRef = useRef(() => {})
  const stopWhenStartedRef = useRef(false)
  const generationRef = useRef(0)

  useLayoutEffect(() => {
    // Native audio events can arrive before passive Effects flush, but refs
    // should only expose options from a committed render.
    clientRef.current = client
    enabledRef.current = enabled
    onTranscriptRef.current = onTranscript
    onErrorRef.current = onError
  }, [client, enabled, onTranscript, onError])

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
    startBufferRef.current.clear()
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
      const client = clientRef.current
      if (activeIdRef.current !== dictationId) {
        return
      }
      activeIdRef.current = null
      closeDictationAudio()
      if (client && dictationId) {
        void cancelDesktopDictation(client, dictationId)
      }
      const kept = keptTranscript.take(dictationId)
      if (kept) {
        onTranscriptRef.current(kept)
      }
      reportError(err)
    },
    [closeDictationAudio, reportError]
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
      startBuffer: startBufferRef.current
    })
    sendHeldAudioRef.current = sub.sendHeld
    return () => sub.remove()
  }, [capture, failActiveDictation])

  const finishDictation = useCallback(
    async (emptyTranscriptMessage: string) => {
      const client = clientRef.current
      const dictationId = activeIdRef.current
      if (!client || !dictationId) {
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
        audioPhaseRef.current = 'closed'
        await Promise.allSettled(Array.from(pendingChunksRef.current))
        if (!isCurrent()) {
          return
        }
        const finished = await finishDesktopDictation(client, dictationId)
        if (!isCurrent()) {
          return
        }
        const transcript = rpcPayloadMember(finished, 'text')
        const text = typeof transcript === 'string' ? transcript.trim() : ''
        activeIdRef.current = null
        pendingChunksRef.current.clear()
        pendingAudioBudgetRef.current.reset()
        applyStatus('idle')
        if (text) {
          onTranscriptRef.current(text)
        } else {
          reportError(new Error(emptyTranscriptMessage))
        }
      } catch (err) {
        failActiveDictation(dictationId, err)
      }
    },
    [applyStatus, capture, failActiveDictation]
  )

  const stop = useCallback(async () => {
    // Speech is held from the tap, so a stop before the host answers finishes once it does.
    if (statusRef.current === 'starting') {
      stopWhenStartedRef.current = true
      return
    }
    await finishDictation(dictationSessionErrorMessage('no-speech'))
  }, [finishDictation])

  const start = useCallback(async () => {
    const client = clientRef.current
    if (!client || !enabledRef.current || activeIdRef.current) {
      return
    }

    const generation = generationRef.current + 1
    generationRef.current = generation
    stopWhenStartedRef.current = false
    setError(null)
    applyStatus('starting')
    const isCurrentGeneration = () => generationRef.current === generation
    const recording = await openMobileDictationCapture({
      capture,
      isCurrent: () => isCurrentGeneration() && enabledRef.current,
      isCurrentGeneration,
      setIdle: () => applyStatus('idle'),
      // Record from the tap: speech during the host's engine build and the round trip is held, not lost.
      hold: () => {
        audioPhaseRef.current = 'holding'
      },
      close: closeDictationAudio
    })
    if (!recording) {
      return
    }
    const dictationId = createMobileDictationId()
    activeIdRef.current = dictationId
    await settledDesktopDictationWork(client)
    if (!isCurrentGeneration()) {
      return
    }

    await startMobileDictationDesktopSession({
      client,
      dictationId,
      generation,
      getCurrentGeneration: () => generationRef.current,
      getEnabled: () => enabledRef.current,
      getActiveId: () => activeIdRef.current,
      clearActiveId: (id) => {
        if (activeIdRef.current === id) {
          activeIdRef.current = null
        }
      },
      setIdle: () => applyStatus('idle'),
      commitRecordingStart: (hostDedupesResends) => {
        audioPhaseRef.current = 'sending'
        pendingChunksRef.current.clear()
        pendingAudioBudgetRef.current.reset(hostDedupesResends)
        applyStatus('recording')
        sendHeldAudioRef.current()
        if (stopWhenStartedRef.current) {
          void finishDictation(dictationSessionErrorMessage('no-speech'))
        }
      },
      rollbackRecordingStart: closeDictationAudio
    })
  }, [applyStatus, capture, closeDictationAudio, finishDictation])

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
      if (client && dictationId) {
        await cancelDesktopDictation(client, dictationId)
      }
    },
    [applyStatus, closeDictationAudio, reportError]
  )

  const cancel = useCallback(() => abandonDictation(null), [abandonDictation])

  useEffect(() => {
    // Finish what was already streamed; only the user's own cancel may discard it.
    const sub = capture.onInterruption(() => {
      if (statusRef.current === 'recording') {
        void finishDictation(dictationSessionErrorMessage('interrupted'))
      } else if (statusRef.current === 'starting') {
        void abandonDictation(dictationSessionErrorMessage('interrupted'))
      }
    })
    return () => sub.remove()
  }, [abandonDictation, capture, finishDictation])

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
      if (clientRef.current && dictationId) {
        void cancelDesktopDictation(clientRef.current, dictationId)
      }
    }
  }, [capture, closeDictationAudio])

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
