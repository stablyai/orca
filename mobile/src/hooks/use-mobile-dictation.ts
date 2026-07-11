import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  addExpoTwoWayAudioEventListener,
  initialize,
  requestMicrophonePermissionsAsync,
  tearDown,
  toggleRecording
} from '@orca/expo-two-way-audio'
import { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'
import { enqueueMobileDictationAudioChunk } from './mobile-dictation-audio-chunk'
import { createMobileDictationKeepAwakeOwner } from './mobile-dictation-keep-awake'
import { useMobileDictationForegroundKeepAwake } from './mobile-dictation-foreground-keep-awake'
import {
  DICTATION_FINISH_TIMEOUT_MS,
  createMobileDictationId,
  isCurrentMobileDictationFinish
} from './mobile-dictation-session-state'
import { startMobileDictationDesktopSession } from './mobile-dictation-desktop-start'
import type {
  DictationStatus,
  UseMobileDictationOptions,
  UseMobileDictationResult
} from './mobile-dictation-session-state'

export type { UseMobileDictationResult } from './mobile-dictation-session-state'

export function useMobileDictation(options: UseMobileDictationOptions): UseMobileDictationResult {
  const { client, enabled, onTranscript, onError } = options
  const keepAwakeOwner = useMemo(createMobileDictationKeepAwakeOwner, [])
  const [status, setStatus] = useState<DictationStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const clientRef = useRef(client)
  const enabledRef = useRef(enabled)
  const onTranscriptRef = useRef(onTranscript)
  const onErrorRef = useRef(onError)
  const pendingChunksRef = useRef<Set<Promise<void>>>(new Set())
  const pendingAudioBudgetRef = useRef(new MobileDictationPendingAudioBudget())
  const acceptingChunksRef = useRef(false)
  const generationRef = useRef(0)
  const finishingIdRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    // Native audio events can arrive before passive Effects flush, but refs
    // should only expose options from a committed render.
    clientRef.current = client
    enabledRef.current = enabled
    onTranscriptRef.current = onTranscript
    onErrorRef.current = onError
  }, [client, enabled, onTranscript, onError])

  const reportError = useCallback((err: unknown) => {
    const normalized = err instanceof Error ? err : new Error(String(err))
    setError(normalized.message)
    setStatus('error')
    onErrorRef.current?.(normalized)
  }, [])

  const closeDictationAudio = useCallback(
    (dictationId?: string | null) => {
      acceptingChunksRef.current = false
      pendingChunksRef.current.clear()
      pendingAudioBudgetRef.current.reset()
      try {
        toggleRecording(false)
      } catch (err) {
        // Cleanup must keep going when native recording shutdown throws, or
        // the wake tag and dictation state would leak.
        console.error('Failed to stop microphone recording', err)
      }
      void keepAwakeOwner.release(dictationId ?? undefined).catch(() => undefined)
    },
    [keepAwakeOwner]
  )

  const failActiveDictation = useCallback(
    (dictationId: string, err: unknown) => {
      const client = clientRef.current
      if (activeIdRef.current !== dictationId) {
        return
      }
      activeIdRef.current = null
      closeDictationAudio(dictationId)
      if (client && dictationId) {
        void client.sendRequest('speech.dictation.cancel', { dictationId }).catch(() => undefined)
      }
      reportError(err)
    },
    [closeDictationAudio, reportError]
  )

  useEffect(() => {
    // Microphone events are a hot path; reuse this wiring instead of allocating
    // a queue object and release predicate for every audio chunk.
    const audioChunkQueue = {
      pendingChunks: pendingChunksRef.current,
      pendingAudioBudget: pendingAudioBudgetRef.current,
      shouldReleaseBudget: (id: string) =>
        activeIdRef.current === id || finishingIdRef.current === id,
      failActiveDictation
    }
    const sub = addExpoTwoWayAudioEventListener('onMicrophoneData', (event) => {
      const client = clientRef.current
      const dictationId = activeIdRef.current
      if (!client || !dictationId || !enabledRef.current || !acceptingChunksRef.current) {
        return
      }
      enqueueMobileDictationAudioChunk(client, dictationId, event, audioChunkQueue)
    })
    return () => sub.remove()
  }, [failActiveDictation, reportError])

  const start = useCallback(async () => {
    const client = clientRef.current
    if (!client || !enabledRef.current || activeIdRef.current) {
      return
    }

    const generation = generationRef.current + 1
    generationRef.current = generation
    setError(null)
    setStatus('starting')
    const permission = await requestMicrophonePermissionsAsync()
    if (generationRef.current !== generation || !enabledRef.current) {
      if (generationRef.current === generation) {
        setStatus('idle')
      }
      return
    }
    if (!permission.granted) {
      setStatus('idle')
      throw new Error('Microphone permission denied')
    }

    const initialized = await initialize()
    if (generationRef.current !== generation || !enabledRef.current) {
      void tearDown()
      if (generationRef.current === generation) {
        setStatus('idle')
      }
      return
    }
    if (!initialized) {
      setStatus('idle')
      throw new Error('Failed to initialize microphone')
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
      setIdle: () => setStatus('idle'),
      keepAwakeOwner,
      commitRecordingStart: () => {
        acceptingChunksRef.current = true
        pendingChunksRef.current.clear()
        pendingAudioBudgetRef.current.reset()
        if (!toggleRecording(true)) {
          return false
        }
        setStatus('recording')
        return true
      },
      rollbackRecordingStart: () => {
        acceptingChunksRef.current = false
        pendingChunksRef.current.clear()
        pendingAudioBudgetRef.current.reset()
        toggleRecording(false)
      }
    })
  }, [keepAwakeOwner])

  const stop = useCallback(async () => {
    const client = clientRef.current
    const dictationId = activeIdRef.current
    if (!client || !dictationId) {
      return
    }

    const generation = generationRef.current + 1
    generationRef.current = generation
    finishingIdRef.current = dictationId
    setStatus('processing')
    acceptingChunksRef.current = false
    try {
      // Inside the try so a throwing native shutdown still runs the finally
      // release and error cleanup.
      toggleRecording(false)
      await Promise.allSettled(Array.from(pendingChunksRef.current))
      if (
        !isCurrentMobileDictationFinish(
          generationRef.current,
          generation,
          enabledRef.current,
          activeIdRef.current,
          finishingIdRef.current,
          dictationId
        )
      ) {
        return
      }
      const response = await client.sendRequest(
        'speech.dictation.finish',
        { dictationId },
        { timeoutMs: DICTATION_FINISH_TIMEOUT_MS }
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      if (
        !isCurrentMobileDictationFinish(
          generationRef.current,
          generation,
          enabledRef.current,
          activeIdRef.current,
          finishingIdRef.current,
          dictationId
        )
      ) {
        return
      }
      const result = response.result as { text?: unknown }
      const text = typeof result.text === 'string' ? result.text.trim() : ''
      activeIdRef.current = null
      finishingIdRef.current = null
      pendingChunksRef.current.clear()
      pendingAudioBudgetRef.current.reset()
      setStatus('idle')
      if (text) {
        onTranscriptRef.current(text)
      } else {
        reportError(new Error('No speech detected.'))
      }
    } catch (err) {
      failActiveDictation(dictationId, err)
    } finally {
      // Hold the wake tag through chunk drain and the finish RPC: a screen
      // lock mid-processing suspends the app and loses the transcript.
      void keepAwakeOwner.release(dictationId).catch(() => undefined)
      if (finishingIdRef.current === dictationId) {
        finishingIdRef.current = null
      }
    }
  }, [failActiveDictation, keepAwakeOwner])

  const cancel = useCallback(async () => {
    const client = clientRef.current
    const dictationId = activeIdRef.current
    generationRef.current += 1
    activeIdRef.current = null
    finishingIdRef.current = null
    closeDictationAudio(dictationId)
    if (client && dictationId) {
      await client.sendRequest('speech.dictation.cancel', { dictationId }).catch(() => undefined)
    }
    setStatus('idle')
    setError(null)
  }, [closeDictationAudio])

  useMobileDictationForegroundKeepAwake(keepAwakeOwner, activeIdRef)

  useEffect(() => {
    const sub = addExpoTwoWayAudioEventListener('onAudioInterruption', (event) => {
      if (event.data === 'began' || event.data === 'blocked') {
        void cancel()
      }
    })
    return () => sub.remove()
  }, [cancel])

  useEffect(() => {
    if (!enabled) {
      void cancel()
    }
  }, [cancel, enabled])

  useEffect(() => {
    return () => {
      const dictationId = activeIdRef.current
      generationRef.current += 1
      activeIdRef.current = null
      finishingIdRef.current = null
      closeDictationAudio(dictationId)
      void tearDown()
      if (clientRef.current && dictationId) {
        void clientRef.current
          .sendRequest('speech.dictation.cancel', { dictationId })
          .catch(() => undefined)
      }
    }
  }, [closeDictationAudio])

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
