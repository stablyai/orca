import {
  DICTATION_SAMPLE_RATE,
  MOBILE_DICTATION_RECONNECT_GRACE_MS,
  PCM_BYTES_PER_SAMPLE
} from '../../../src/shared/rpc-contract/speech-params'

export const MOBILE_DICTATION_PCM_SAMPLE_RATE = DICTATION_SAMPLE_RATE

// Hold the speech captured while a reconnect is pending, for as long as the host keeps the session.
const MAX_PENDING_AUDIO_SECONDS = MOBILE_DICTATION_RECONNECT_GRACE_MS / 1000

// Why: dictation chunk RPCs wait through reconnect before timing out, so
// cap retained raw microphone audio before it is expanded into base64 payloads.
const MOBILE_DICTATION_MAX_PENDING_AUDIO_BYTES =
  MOBILE_DICTATION_PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * MAX_PENDING_AUDIO_SECONDS

export const MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE =
  'Connection is too slow for voice dictation. Try again when the connection improves.'

export class MobileDictationPendingAudioBudget {
  private pendingBytes = 0

  constructor(private readonly maxPendingBytes = MOBILE_DICTATION_MAX_PENDING_AUDIO_BYTES) {}

  get pendingAudioBytes(): number {
    return this.pendingBytes
  }

  tryReserve(byteLength: number): boolean {
    const normalizedByteLength = normalizeByteLength(byteLength)
    if (this.pendingBytes + normalizedByteLength > this.maxPendingBytes) {
      return false
    }
    this.pendingBytes += normalizedByteLength
    return true
  }

  release(byteLength: number): void {
    this.pendingBytes = Math.max(0, this.pendingBytes - normalizeByteLength(byteLength))
  }

  reset(): void {
    this.pendingBytes = 0
  }
}

function normalizeByteLength(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return 0
  }
  return Math.floor(byteLength)
}
