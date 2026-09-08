import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HostSessionDictationOperations } from '../session/host-session-dictation-operations'
import type {
  DictationStatus,
  UseMobileDictationOptions,
  UseMobileDictationResult
} from './mobile-dictation-session-state'

type HostedMobileDictationOptions = Omit<UseMobileDictationOptions, 'client'> & {
  operations: HostSessionDictationOperations | null
}

export function useHostedMobileDictation(
  options: HostedMobileDictationOptions
): UseMobileDictationResult {
  const { operations, enabled, onTranscript, onError } = options
  const [status, setStatus] = useState<DictationStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const operationsRef = useRef(operations)
  const enabledRef = useRef(enabled)
  const onTranscriptRef = useRef(onTranscript)
  const onErrorRef = useRef(onError)

  useLayoutEffect(() => {
    operationsRef.current = operations
    enabledRef.current = enabled
    onTranscriptRef.current = onTranscript
    onErrorRef.current = onError
  }, [enabled, onError, onTranscript, operations])

  const reportError = useCallback((value: unknown) => {
    const next = value instanceof Error ? value : new Error(String(value))
    setError(next.message)
    setStatus('error')
    onErrorRef.current?.(next)
  }, [])

  useEffect(() => {
    if (!operations) {
      setStatus('idle')
      setError(null)
      return
    }
    const subscription = operations.subscribe((event) => {
      if (event.status === 'recording' || event.status === 'processing') {
        setStatus(event.status)
        return
      }
      if (event.reason === 'connection-slow') {
        reportError(
          new Error(
            'Connection is too slow for voice dictation. Try again when the connection improves.'
          )
        )
        return
      }
      if (event.reason === 'host-error') {
        reportError(new Error('Voice dictation failed on the paired desktop.'))
        return
      }
      setError(null)
      setStatus('idle')
    }, reportError)
    void subscription.ready.catch(() => undefined)
    return () => subscription.unsubscribe()
  }, [operations, reportError])

  const start = useCallback(async () => {
    const activeOperations = operationsRef.current
    if (!activeOperations || !enabledRef.current) {
      return
    }
    setError(null)
    setStatus('starting')
    try {
      const result = await activeOperations.start()
      if (operationsRef.current !== activeOperations || !enabledRef.current) {
        return
      }
      if (result.status === 'recording') {
        setStatus('recording')
        return
      }
      setStatus('idle')
      if (result.status === 'permission-denied') {
        throw new Error('Microphone permission denied')
      }
      if (result.status === 'setup-required') {
        throw new Error(
          result.reason === 'voice_model_not_ready' ? 'voice_model_not_ready:hosted' : result.reason
        )
      }
      throw new Error('Failed to initialize microphone')
    } catch (value) {
      if (operationsRef.current === activeOperations) {
        setStatus('idle')
      }
      throw value
    }
  }, [])

  const stop = useCallback(async () => {
    const activeOperations = operationsRef.current
    if (!activeOperations) {
      return
    }
    setStatus('processing')
    try {
      const result = await activeOperations.stop()
      if (operationsRef.current !== activeOperations) {
        return
      }
      if (result.status === 'transcript') {
        setError(null)
        setStatus('idle')
        onTranscriptRef.current(result.text)
      } else if (result.status === 'no-speech') {
        reportError(new Error('No speech detected.'))
      } else {
        setError(null)
        setStatus('idle')
      }
    } catch (value) {
      reportError(value)
    }
  }, [reportError])

  const cancel = useCallback(async () => {
    const activeOperations = operationsRef.current
    setError(null)
    setStatus('idle')
    await activeOperations?.cancel().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!enabled) {
      void cancel()
    }
  }, [cancel, enabled])

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
