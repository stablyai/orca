import {
  DICTATION_SAMPLE_RATE,
  MOBILE_DICTATION_MAX_PENDING_AUDIO_BYTES,
  PCM_BYTES_PER_SAMPLE
} from '../../../src/shared/rpc-contract/speech-params'

export const MOBILE_DICTATION_PCM_SAMPLE_RATE = DICTATION_SAMPLE_RATE

export const MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE =
  'Connection is too slow for voice dictation. Try again when the connection improves.'

export class MobileDictationPendingAudioBudget {
  private pendingBytes = 0
  // Audio held before the host committed (a whole on-device dictation, for a replay) is sent first and may exceed the limit; only audio after it counts.
  private backlogBytes = 0
  // Backlog not yet taken into a request; it sits at the front of the held audio.
  private untakenBacklogBytes = 0
  private sentChunks = 0
  private sentBytes = 0
  // Set at each start: a host that feeds each chunk seq once can take audio a drop left unanswered again.
  hostDedupesResends = false

  constructor(private readonly maxPendingBytes = MOBILE_DICTATION_MAX_PENDING_AUDIO_BYTES) {}

  get pendingAudioBytes(): number {
    return this.pendingBytes
  }

  // Numbers a request and counts its audio, which sets how long finish waits.
  nextSeq(byteLength: number): number {
    this.sentBytes += normalizeByteLength(byteLength)
    return this.sentChunks++
  }

  get sentAudioSeconds(): number {
    return this.sentBytes / (PCM_BYTES_PER_SAMPLE * MOBILE_DICTATION_PCM_SAMPLE_RATE)
  }

  reserveBacklog(byteLength: number): void {
    const normalizedByteLength = normalizeByteLength(byteLength)
    this.pendingBytes += normalizedByteLength
    this.backlogBytes += normalizedByteLength
    this.untakenBacklogBytes += normalizedByteLength
  }

  // The backlog share of a request just taken from the front of the held audio; release it with that request.
  takeBacklog(byteLength: number): number {
    const share = Math.min(this.untakenBacklogBytes, normalizeByteLength(byteLength))
    this.untakenBacklogBytes -= share
    return share
  }

  tryReserve(byteLength: number): boolean {
    const normalizedByteLength = normalizeByteLength(byteLength)
    if (this.pendingBytes + normalizedByteLength > this.maxPendingBytes + this.backlogBytes) {
      return false
    }
    this.pendingBytes += normalizedByteLength
    return true
  }

  // Requests settle out of order, so each releases only its own backlog share.
  release(byteLength: number, backlogShare = 0): void {
    this.pendingBytes = Math.max(0, this.pendingBytes - normalizeByteLength(byteLength))
    this.backlogBytes = Math.max(0, this.backlogBytes - normalizeByteLength(backlogShare))
  }

  reset(hostDedupesResends = false): void {
    this.pendingBytes = 0
    this.backlogBytes = 0
    this.untakenBacklogBytes = 0
    this.sentChunks = 0
    this.sentBytes = 0
    this.hostDedupesResends = hostDedupesResends
  }
}

function normalizeByteLength(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return 0
  }
  return Math.floor(byteLength)
}
