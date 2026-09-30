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
  // One seam, two hosts: natively the microphone, on the page the shell's three audio verbs.
  // Everything below this line is the same flow either way, the screen included — an open
  // microphone holds it on the device side, under both halves.
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
    // Microphone events are a hot path; reuse this wiring instead of allocating
    // a queue object and release predicate for every audio chunk.
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
    applyStatus('starting')
    let opened
    try {
      opened = await capture.open()
    } catch (err) {
      // Same check the arm below makes, for the same reason: a refusal this start no longer owns
      // must not idle what replaced it, nor toast over the closure the disable already reported.
      if (generationRef.current !== generation || !enabledRef.current) {
        return
      }
      // A capture the host refused outright, which on the page is a route that was never granted
      // the audio verbs. Back to idle before it is rethrown: the caller toasts the shell's own
      // message, and a control left on 'starting' has no way back short of a remount.
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

  const stop = useCallback(async () => {
    const client = clientRef.current
    const dictationId = activeIdRef.current
    if (!client || !dictationId) {
      return
    }

    const generation = generationRef.current + 1
    generationRef.current = generation
    applyStatus('processing')
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
        reportError(new Error('No speech detected.'))
      }
    } catch (err) {
      failActiveDictation(dictationId, err)
    }
  }, [applyStatus, capture, failActiveDictation])

  /**
   * Ends whatever dictation is underway. `reason === null` is the user's own cancel, the one silent
   * end a tap is allowed; anything else reaches `onError`, because a start the user asked for that
   * stops before it records has nothing else to show for the tap.
   */
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
      // The cancel is a desktop round trip, and a start that landed inside it owns the status by
      // now: reporting here would toast over a live recording, and resetting would idle one.
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
    const sub = capture.onInterruption(() => {
      void cancel()
    })
    return () => sub.remove()
  }, [cancel, capture])

  useEffect(() => {
    if (!enabled) {
      // Not the user's cancel: the composer lost its send while the tap was still in flight.
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
