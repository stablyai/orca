import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDictationCapture } from '../platform/dictation-capture'
import {
  MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE,
  MobileDictationPendingAudioBudget
} from './mobile-dictation-pending-audio-budget'
import { enqueueMobileDictationAudioChunk } from './mobile-dictation-audio-chunk'
import { createMobileDictationKeepAwakeOwner } from './mobile-dictation-keep-awake'
import { useMobileDictationForegroundKeepAwake } from './mobile-dictation-foreground-keep-awake'
import {
  DICTATION_FINISH_TIMEOUT_MS,
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
  // One seam, two hosts: natively the microphone and `expo-keep-awake`, on the page the shell's
  // four verbs. Everything below this line is the same flow either way.
  const capture = useDictationCapture()
  const keepAwakeOwner = useMemo(
    () => createMobileDictationKeepAwakeOwner(capture.keepAwake),
    [capture]
  )
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
        void capture.end()
      } catch (err) {
        // Cleanup must keep going when native recording shutdown throws, or
        // the wake tag and dictation state would leak.
        console.error('Failed to stop microphone recording', err)
      }
      void keepAwakeOwner.release(dictationId ?? undefined).catch(() => undefined)
    },
    [capture, keepAwakeOwner]
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
        void dictationSessionCancel.request(client, { dictationId }).catch(() => undefined)
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
    const sub = capture.onChunk((chunk) => {
      const client = clientRef.current
      const dictationId = activeIdRef.current
      if (!client || !dictationId || !enabledRef.current || !acceptingChunksRef.current) {
        return
      }
      if (chunk.droppedBytes > 0) {
        // Audio the capture already lost is the condition the budget refuses on by another route —
        // the page is not keeping up with the microphone — so it reaches the one message the
        // composer renders for it. Only the page can drop: natively this is always zero.
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
    setStatus('starting')
    let opened
    try {
      opened = await capture.open()
    } catch (err) {
      // A capture the host refused outright, which on the page is a route that was never granted
      // the audio verbs. Back to idle before it is rethrown: the caller toasts the shell's own
      // message, and a control left on 'starting' has no way back short of a remount.
      setStatus('idle')
      throw err instanceof Error ? err : new Error(String(err))
    }
    if (generationRef.current !== generation || !enabledRef.current) {
      capture.release()
      if (generationRef.current === generation) {
        setStatus('idle')
      }
      return
    }
    if (!opened.ok) {
      setStatus('idle')
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
      setIdle: () => setStatus('idle'),
      keepAwakeOwner,
      commitRecordingStart: () => {
        acceptingChunksRef.current = true
        pendingChunksRef.current.clear()
        pendingAudioBudgetRef.current.reset()
        if (!capture.begin()) {
          return false
        }
        setStatus('recording')
        return true
      },
      rollbackRecordingStart: () => {
        acceptingChunksRef.current = false
        pendingChunksRef.current.clear()
        pendingAudioBudgetRef.current.reset()
        void capture.end()
      }
    })
  }, [capture, keepAwakeOwner])

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
    try {
      // Inside the try so a throwing native shutdown still runs the finally
      // release and error cleanup.
      //
      // Awaited, and chunks are still accepted while it runs: `end` hands over whatever the
      // capture is still holding, which on the page is up to one drain interval of the tail of
      // what the user just said. Refusing chunks first would drop exactly that audio, and taking
      // the pending set before it would let `finish` overtake the last send.
      await capture.end()
      acceptingChunksRef.current = false
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
          finishingIdRef.current,
          dictationId
        )
      ) {
        return
      }
      const transcript = rpcPayloadMember(finished, 'text')
      const text = typeof transcript === 'string' ? transcript.trim() : ''
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
  }, [capture, failActiveDictation, keepAwakeOwner])

  const cancel = useCallback(async () => {
    const client = clientRef.current
    const dictationId = activeIdRef.current
    generationRef.current += 1
    activeIdRef.current = null
    finishingIdRef.current = null
    closeDictationAudio(dictationId)
    if (client && dictationId) {
      await dictationSessionCancel.request(client, { dictationId }).catch(() => undefined)
    }
    setStatus('idle')
    setError(null)
  }, [closeDictationAudio])

  useMobileDictationForegroundKeepAwake(keepAwakeOwner, activeIdRef, capture.keepAwake)

  useEffect(() => {
    const sub = capture.onInterruption(() => {
      void cancel()
    })
    return () => sub.remove()
  }, [cancel, capture])

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
