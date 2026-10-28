// Use the buffer polyfill: Metro cannot resolve node:buffer in React Native.
import { Buffer } from 'buffer'

import type { RpcClient } from '../transport/rpc-client'

export type DictationStatus = 'idle' | 'starting' | 'recording' | 'processing' | 'error'

export type UseMobileDictationOptions = {
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

export const DICTATION_FINISH_TIMEOUT_MS = 75_000

// An interrupted user tap needs a renderable error; only explicit user cancellation may end silently.
export const MOBILE_DICTATION_INPUT_CLOSED_ERROR_MESSAGE =
  'Voice dictation stopped because this session is no longer accepting input. Try again.'

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export function createMobileDictationId(): string {
  return `mobile-dictation-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function isCurrentMobileDictationStart(
  currentGeneration: number,
  generation: number,
  enabled: boolean,
  activeId: string | null,
  dictationId: string
): boolean {
  return currentGeneration === generation && enabled && activeId === dictationId
}

// Generation and active id fence finish results against cancellation, disable, unmount and newer starts.
export function isCurrentMobileDictationFinish(
  currentGeneration: number,
  generation: number,
  enabled: boolean,
  activeId: string | null,
  dictationId: string
): boolean {
  return currentGeneration === generation && enabled && activeId === dictationId
}
