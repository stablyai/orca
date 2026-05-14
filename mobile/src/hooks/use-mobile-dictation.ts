import { useCallback, useEffect, useRef, useState } from 'react'
import { Buffer } from 'buffer'
import {
  addExpoTwoWayAudioEventListener,
  initialize,
  requestMicrophonePermissionsAsync,
  tearDown,
  toggleRecording
} from '@orca/expo-two-way-audio'
import type { RpcClient } from '../transport/rpc-client'

type DictationStatus = 'idle' | 'starting' | 'recording' | 'processing' | 'error'

type UseMobileDictationOptions = {
  client: RpcClient | null
  enabled: boolean
  onTranscript: (text: string) => void
  onError?: (error: Error) => void
}

export type UseMobileDictationResult = {
  status: DictationStatus
  isStarting: boolean
  isRecording: boolean
  isProcessing: boolean
  error: string | null
  start: () => Promise<void>
  stop: () => Promise<void>
  cancel: () => Promise<void>
}

const MOBILE_PCM_SAMPLE_RATE = 16000
const DICTATION_FINISH_TIMEOUT_MS = 75_000

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function createDictationId(): string {
  return `mobile-dictation-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useMobileDictation(options: UseMobileDictationOptions): UseMobileDictationResult {
  const { client, enabled, onTranscript, onError } = options
  const [status, setStatus] = useState<DictationStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const clientRef = useRef(client)
  const enabledRef = useRef(enabled)
  const onTranscriptRef = useRef(onTranscript)
  const onErrorRef = useRef(onError)
  const pendingChunksRef = useRef<Set<Promise<void>>>(new Set())
  const acceptingChunksRef = useRef(false)
  const generationRef = useRef(0)
  const finishingIdRef = useRef<string | null>(null)

  useEffect(() => {
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

  const failActiveDictation = useCallback(
    (dictationId: string, err: unknown) => {
      const client = clientRef.current
      if (activeIdRef.current !== dictationId) {
        return
      }
      activeIdRef.current = null
      acceptingChunksRef.current = false
      pendingChunksRef.current.clear()
      toggleRecording(false)
      if (client && dictationId) {
        void client.sendRequest('speech.dictation.cancel', { dictationId }).catch(() => undefined)
      }
      reportError(err)
    },
    [reportError]
  )

  useEffect(() => {
    const sub = addExpoTwoWayAudioEventListener('onMicrophoneData', (event) => {
      const client = clientRef.current
      const dictationId = activeIdRef.current
      if (!client || !dictationId || !enabledRef.current || !acceptingChunksRef.current) {
        return
      }
      const raw = event.data
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
      const sendChunk = client
        .sendRequest('speech.dictation.chunk', {
          dictationId,
          audioBase64: bytesToBase64(bytes),
          sampleRate: MOBILE_PCM_SAMPLE_RATE
        })
        .then((response) => {
          if (!response.ok) {
            throw new Error(response.error.message)
          }
        })
        .catch((err) => failActiveDictation(dictationId, err))
        .finally(() => {
          pendingChunksRef.current.delete(sendChunk)
        })
      pendingChunksRef.current.add(sendChunk)
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

    const dictationId = createDictationId()
    activeIdRef.current = dictationId
    try {
      const response = await client.sendRequest('speech.dictation.start', { dictationId })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
    } catch (err) {
      if (activeIdRef.current === dictationId) {
        activeIdRef.current = null
      }
      await client.sendRequest('speech.dictation.cancel', { dictationId }).catch(() => undefined)
      setStatus('idle')
      throw err
    }
    if (
      generationRef.current !== generation ||
      !enabledRef.current ||
      activeIdRef.current !== dictationId
    ) {
      await client.sendRequest('speech.dictation.cancel', { dictationId }).catch(() => undefined)
      if (activeIdRef.current === dictationId) {
        activeIdRef.current = null
      }
      setStatus('idle')
      return
    }

    acceptingChunksRef.current = true
    pendingChunksRef.current.clear()
    toggleRecording(true)
    setStatus('recording')
  }, [])

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
    toggleRecording(false)
    try {
      await Promise.allSettled(Array.from(pendingChunksRef.current))
      if (
        generationRef.current !== generation ||
        activeIdRef.current !== dictationId ||
        finishingIdRef.current !== dictationId ||
        !enabledRef.current
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
        generationRef.current !== generation ||
        activeIdRef.current !== dictationId ||
        finishingIdRef.current !== dictationId ||
        !enabledRef.current
      ) {
        return
      }
      const result = response.result as { text?: unknown }
      const text = typeof result.text === 'string' ? result.text.trim() : ''
      activeIdRef.current = null
      finishingIdRef.current = null
      pendingChunksRef.current.clear()
      setStatus('idle')
      if (text) {
        onTranscriptRef.current(text)
      } else {
        reportError(new Error('No speech detected.'))
      }
    } catch (err) {
      failActiveDictation(dictationId, err)
    } finally {
      if (finishingIdRef.current === dictationId) {
        finishingIdRef.current = null
      }
    }
  }, [failActiveDictation])

  const cancel = useCallback(async () => {
    const client = clientRef.current
    const dictationId = activeIdRef.current
    generationRef.current += 1
    activeIdRef.current = null
    finishingIdRef.current = null
    acceptingChunksRef.current = false
    pendingChunksRef.current.clear()
    toggleRecording(false)
    if (client && dictationId) {
      await client.sendRequest('speech.dictation.cancel', { dictationId }).catch(() => undefined)
    }
    setStatus('idle')
    setError(null)
  }, [])

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
      acceptingChunksRef.current = false
      pendingChunksRef.current.clear()
      toggleRecording(false)
      void tearDown()
      if (clientRef.current && dictationId) {
        void clientRef.current
          .sendRequest('speech.dictation.cancel', { dictationId })
          .catch(() => undefined)
      }
    }
  }, [])

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
