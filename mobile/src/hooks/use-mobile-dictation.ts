import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDictationCapture } from '../platform/dictation-capture'
import {
  MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE,
  MobileDictationPendingAudioBudget
} from './mobile-dictation-pending-audio-budget'
import { enqueueMobileDictationAudioChunk } from './mobile-dictation-audio-chunk'
import {
  DICTATION_FINISH_TIMEOUT_MS,
  MOBILE_DICTATION_INPUT_CLOSED_ERROR_MESSAGE,
  MOBILE_DICTATION_INTERRUPTED_ERROR_MESSAGE,
  createMobileDictationId,
  isCurrentMobileDictationFinish
} from './mobile-dictation-session-state'
import { startMobileDictationDesktopSession } from './mobile-dictation-desktop-start'
import {
  dictationSessionCancel,
  dictationSessionFinish
} from '../dictation/mobile-dictation-operations'
import { rpcPayloadMember } from '../transport/rpc-reader-payload'
import type {
  DictationStatus,
  UseMobileDictationOptions,
  UseMobileDictationResult
} from './mobile-dictation-session-state'

export type { UseMobileDictationResult } from './mobile-dictation-session-state'

export function useMobileDictation(options: UseMobileDictationOptions): UseMobileDictationResult {
  const { client, enabled, onTranscript, onError } = options
  // Both capture seams hold the screen while the microphone is open; native uses the device directly and page uses shell audio verbs.
  const capture = useDictationCapture()
  const [status, setStatus] = useState<DictationStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  // Read from an abort that may run between a commit and its passive Effects, where state is stale.
  const statusRef = useRef<DictationStatus>('idle')
  const activeIdRef = useRef<string | null>(null)
  const clientRef = useRef(client)
  const enabledRef = useRef(enabled)
  const onTranscriptRef = useRef(onTranscript)
  const onErrorRef = useRef(onError)
  const pendingChunksRef = useRef<Set<Promise<void>>>(new Set())
  const pendingAudioBudgetRef = useRef(new MobileDictationPendingAudioBudget())
  const acceptingChunksRef = useRef(false)
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
    acceptingChunksRef.current = false
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
        void dictationSessionCancel.request(client, { dictationId }).catch(() => undefined)
      }
      reportError(err)
    },
    [closeDictationAudio, reportError]
  )

  useEffect(() => {
    // Reuse wiring on the microphone hot path instead of allocating per chunk.
    const audioChunkQueue = {
      pendingChunks: pendingChunksRef.current,
      pendingAudioBudget: pendingAudioBudgetRef.current,
      shouldReleaseBudget: (id: string) => activeIdRef.current === id,
      failActiveDictation
    }
    const sub = capture.onChunk((chunk) => {
      const client = clientRef.current
      const dictationId = activeIdRef.current
      if (!client || !dictationId || !enabledRef.current || !acceptingChunksRef.current) {
        return
      }
      if (chunk.droppedBytes > 0) {
        // Page capture loss and budget overflow both mean the page fell behind the microphone; report the same error. Native capture never drops here.
        failActiveDictation(dictationId, new Error(MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE))
        return
      }
      enqueueMobileDictationAudioChunk(client, dictationId, chunk, audioChunkQueue)
    })
    return () => sub.remove()
  }, [capture, failActiveDictation, reportError])

  const start = useCallback(async () => {
    const client = clientRef.current
    if (!client || !enabledRef.current || activeIdRef.current) {
      return
    }

    const generation = generationRef.current + 1
    generationRef.current = generation
    setError(null)
    applyStatus('starting')
    let opened
    try {
      opened = await capture.open()
    } catch (err) {
      // Stale refusal must neither idle the replacement nor toast over the closure already reported by disable.
      if (generationRef.current !== generation || !enabledRef.current) {
        return
      }
      // A page without audio grants can refuse capture; return to idle before rethrowing its message so starting cannot get stuck.
      applyStatus('idle')
      throw err instanceof Error ? err : new Error(String(err))
    }
    if (generationRef.current !== generation || !enabledRef.current) {
      capture.release()
      if (generationRef.current === generation) {
        applyStatus('idle')
      }
      return
    }
    if (!opened.ok) {
      applyStatus('idle')
      throw new Error(
        opened.reason === 'permission-denied'
          ? 'Microphone permission denied'
          : 'Failed to initialize microphone'
      )
    }

    const dictationId = createMobileDictationId()
    activeIdRef.current = dictationId

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
      commitRecordingStart: () => {
        acceptingChunksRef.current = true
        pendingChunksRef.current.clear()
        pendingAudioBudgetRef.current.reset()
        if (!capture.begin()) {
          return false
        }
        applyStatus('recording')
        return true
      },
      rollbackRecordingStart: () => {
        acceptingChunksRef.current = false
        pendingChunksRef.current.clear()
        pendingAudioBudgetRef.current.reset()
        void capture.end()
      }
    })
  }, [applyStatus, capture])

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
      try {
        // Keep shutdown inside try for finally cleanup; accept its tail chunks and snapshot pending sends only after end settles, or finish can overtake the last audio.
        await capture.end()
        acceptingChunksRef.current = false
        await Promise.allSettled(Array.from(pendingChunksRef.current))
        if (
          !isCurrentMobileDictationFinish(
            generationRef.current,
            generation,
            enabledRef.current,
            activeIdRef.current,
            dictationId
          )
        ) {
          return
        }
        const finished = dictationSessionFinish.interpret(
          await dictationSessionFinish.request(
            client,
            { dictationId },
            { timeoutMs: DICTATION_FINISH_TIMEOUT_MS }
          )
        )
        if (
          !isCurrentMobileDictationFinish(
            generationRef.current,
            generation,
            enabledRef.current,
            activeIdRef.current,
            dictationId
          )
        ) {
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

  const stop = useCallback(() => finishDictation('No speech detected.'), [finishDictation])

  // Only the user’s own cancel (reason:null) ends silently; other interruptions call onError so the tap has a visible outcome.
  const abandonDictation = useCallback(
    async (reason: string | null) => {
      const client = clientRef.current
      const dictationId = activeIdRef.current
      const wasUnderway = statusRef.current === 'starting' || statusRef.current === 'recording'
      const generation = generationRef.current + 1
      generationRef.current = generation
      activeIdRef.current = null
      closeDictationAudio()
      if (client && dictationId) {
        await dictationSessionCancel.request(client, { dictationId }).catch(() => undefined)
      }
      // The cancel round trip may overlap a new recording; stale completion must neither report over it nor reset it.
      if (generationRef.current !== generation) {
        return
      }
      if (reason !== null && wasUnderway) {
        reportError(new Error(reason))
        return
      }
      applyStatus('idle')
      setError(null)
    },
    [applyStatus, closeDictationAudio, reportError]
  )

  const cancel = useCallback(() => abandonDictation(null), [abandonDictation])

  useEffect(() => {
    // Finish what was already streamed; only the user's own cancel may discard it.
    const sub = capture.onInterruption(() => {
      if (statusRef.current === 'recording') {
        void finishDictation(MOBILE_DICTATION_INTERRUPTED_ERROR_MESSAGE)
      } else if (statusRef.current === 'starting') {
        void abandonDictation(MOBILE_DICTATION_INTERRUPTED_ERROR_MESSAGE)
      }
    })
    return () => sub.remove()
  }, [abandonDictation, capture, finishDictation])

  useEffect(() => {
    if (!enabled) {
      void abandonDictation(MOBILE_DICTATION_INPUT_CLOSED_ERROR_MESSAGE)
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
        void dictationSessionCancel
          .request(clientRef.current, { dictationId })
          .catch(() => undefined)
      }
    }
  }, [capture, closeDictationAudio])

  return {
    status,
    isStarting: status === 'starting',
    isRecording: status === 'recording',
    isProcessing: status === 'processing',
    error,
    start,
    stop,
    cancel
  }
}
