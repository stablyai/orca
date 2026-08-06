// Why: import from 'buffer' (the npm polyfill), not 'node:buffer' because
// Metro cannot resolve Node builtins in a React Native bundle.
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

// Recording start waits at most this long for the best-effort wake tag; a
// slow or hung native keep-awake module must not hold the mic in 'starting'.
export const MOBILE_DICTATION_KEEP_AWAKE_STARTUP_BUDGET_MS = 500

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

export function isCurrentMobileDictationFinish(
  currentGeneration: number,
  generation: number,
  enabled: boolean,
  activeId: string | null,
  finishingId: string | null,
  dictationId: string
): boolean {
  return (
    currentGeneration === generation &&
    enabled &&
    activeId === dictationId &&
    finishingId === dictationId
  )
}
