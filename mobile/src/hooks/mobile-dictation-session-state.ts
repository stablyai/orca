// Use the buffer polyfill: Metro cannot resolve node:buffer in React Native.
import { Buffer } from 'buffer'

import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { MobileDictationMeter } from './mobile-dictation-meter'

export type DictationStatus = 'idle' | 'starting' | 'recording' | 'processing' | 'error'

// Who is transcribing, for the icon by the timer; movedAt marks when Automatic moved from the phone to the computer.
export type MobileDictationEngineShown = { kind: 'phone' | 'computer'; movedAt: number | null }

// offline: the computer was out of reach when it failed, which is the reason the user needs.
export type MobileDictationKeptFailure = { message: string; offline: boolean }

export type UseMobileDictationOptions = {
  client: RpcClient | null
  enabled: boolean
  onTranscript: (text: string) => void
  // kept: the recording is kept for Retry, so the failure shows in place rather than as a toast.
  onError?: (error: Error, outcome: { kept: boolean }) => void
  // The computer's filler switch, for text the phone recognizes itself; unknown means on.
  removeFillerWords?: boolean
  // The host's cloud upload is full; the dictation stops and inserts what was kept.
  onAudioLimitReached?: () => void
}

export type UseMobileDictationResult = {
  status: DictationStatus
  isStarting: boolean
  isRecording: boolean
  isProcessing: boolean
  // Empty until a newer host reports words; older hosts never do.
  transcriptSoFar: string
  error: string | null
  // A failure whose recording is kept: Retry plays it to the computer again, cancel discards it.
  failure: MobileDictationKeptFailure | null
  // Null until recording starts on an engine.
  engine: MobileDictationEngineShown | null
  start: () => Promise<void>
  stop: () => Promise<void>
  retry: () => Promise<void>
  cancel: () => Promise<void>
  meter: MobileDictationMeter
}

// An interrupted user tap needs a renderable error; only explicit user cancellation may end silently.
export const MOBILE_DICTATION_INPUT_CLOSED_ERROR_MESSAGE =
  'Voice dictation stopped because this session is no longer accepting input. Try again.'

// Calls, Siri and mic dropouts end capture before anything was transcribed.
export const MOBILE_DICTATION_INTERRUPTED_ERROR_MESSAGE =
  'Voice dictation stopped because the microphone was interrupted. Try again.'

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
