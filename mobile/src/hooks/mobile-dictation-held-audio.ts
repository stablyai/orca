import { MAX_DICTATION_AUDIO_CHUNK_BYTES } from '../../../src/shared/rpc-contract/speech-params'
import type { DictationCaptureChunk } from '../platform/dictation-capture-contract'

// Speech not sent yet, in order: held between the tap and the host's start reply, and while every send slot is busy.
export class MobileDictationHeldAudio {
  private held: DictationCaptureChunk[] = []

  hold(chunk: DictationCaptureChunk): void {
    this.held.push(chunk)
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
  }
}
