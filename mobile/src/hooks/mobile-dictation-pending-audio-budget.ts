import {
  DICTATION_SAMPLE_RATE,
  MOBILE_DICTATION_MAX_PENDING_AUDIO_BYTES
} from '../../../src/shared/rpc-contract/speech-params'

export const MOBILE_DICTATION_PCM_SAMPLE_RATE = DICTATION_SAMPLE_RATE

export const MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE =
  'Connection is too slow for voice dictation. Try again when the connection improves.'

export class MobileDictationPendingAudioBudget {
  private pendingBytes = 0
  private sentChunks = 0
  // Set at each start: a host that feeds each chunk seq once can take audio a drop left unanswered again.
  hostDedupesResends = false

  constructor(private readonly maxPendingBytes = MOBILE_DICTATION_MAX_PENDING_AUDIO_BYTES) {}

  get pendingAudioBytes(): number {
    return this.pendingBytes
  }

  nextSeq(): number {
    return this.sentChunks++
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

  reset(hostDedupesResends = false): void {
    this.pendingBytes = 0
    this.sentChunks = 0
    this.hostDedupesResends = hostDedupesResends
  }
}

function normalizeByteLength(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return 0
  }
  return Math.floor(byteLength)
}
