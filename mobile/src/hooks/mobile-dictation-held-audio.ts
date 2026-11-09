import {
  DICTATION_SAMPLE_RATE,
  MAX_DICTATION_AUDIO_CHUNK_BYTES,
  PCM_BYTES_PER_SAMPLE
} from '../../../src/shared/rpc-contract/speech-params'
import type { DictationCaptureChunk } from '../platform/dictation-capture-contract'

// Five minutes of 16 kHz PCM (9.6 MB): the longest recording kept for a replay to the computer.
export const MAX_HELD_AUDIO_BYTES = DICTATION_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * 300

// Speech not sent yet, in order: held between the tap and the host's start reply, while every send slot is busy, and for a replay of the recording.
export class MobileDictationHeldAudio {
  private held: DictationCaptureChunk[] = []
  private heldBytes = 0
  private heldDroppedBytes = 0
  private overflowed = false

  hold(chunk: DictationCaptureChunk): void {
    if (this.overflowed) {
      return
    }
    // Past the cap a replay would lose speech, so keep nothing and let the caller refuse it.
    if (this.heldBytes + chunk.data.byteLength > MAX_HELD_AUDIO_BYTES) {
      this.clear()
      this.overflowed = true
      return
    }
    this.held.push(chunk)
    this.heldBytes += chunk.data.byteLength
    this.heldDroppedBytes += chunk.droppedBytes
  }

  get bytes(): number {
    return this.heldBytes
  }

  // Capture lost audio while it was held: the page fell behind the microphone.
  get droppedBytes(): number {
    return this.heldDroppedBytes
  }

  // False once speech was dropped past the cap; the held audio no longer covers the whole dictation.
  get complete(): boolean {
    return !this.overflowed
  }

  // Merge into one wire-sized chunk so a backlog costs a few requests, not one per capture event.
  takeNext(): DictationCaptureChunk | null {
    if (this.held.length === 0) {
      return null
    }
    let count = 0
    let bytes = 0
    let droppedBytes = 0
    for (const chunk of this.held) {
      if (count > 0 && bytes + chunk.data.byteLength > MAX_DICTATION_AUDIO_CHUNK_BYTES) {
        break
      }
      count += 1
      bytes += chunk.data.byteLength
      droppedBytes += chunk.droppedBytes
    }
    const parts = this.held.splice(0, count)
    this.heldBytes -= bytes
    this.heldDroppedBytes -= droppedBytes
    if (parts.length === 1) {
      return parts[0]
    }
    const data = new Uint8Array(bytes)
    let offset = 0
    for (const part of parts) {
      data.set(part.data, offset)
      offset += part.data.byteLength
    }
    return { data, droppedBytes }
  }

  take(): DictationCaptureChunk[] {
    const merged: DictationCaptureChunk[] = []
    for (let next = this.takeNext(); next; next = this.takeNext()) {
      merged.push(next)
    }
    return merged
  }

  clear(): void {
    this.held = []
    this.heldBytes = 0
    this.heldDroppedBytes = 0
    this.overflowed = false
  }
}
