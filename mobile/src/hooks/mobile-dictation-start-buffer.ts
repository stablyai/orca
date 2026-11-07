import { MAX_DICTATION_AUDIO_CHUNK_BYTES } from '../../../src/shared/rpc-contract/speech-params'
import type { DictationCaptureChunk } from '../platform/dictation-capture-contract'

// Speech said between the tap and the host's start reply, sent first and in order once recording commits.
export class MobileDictationStartBuffer {
  private held: DictationCaptureChunk[] = []

  hold(chunk: DictationCaptureChunk): void {
    this.held.push(chunk)
  }

  // Merge into wire-sized chunks so a slow start costs a few requests, not one per capture event.
  take(): DictationCaptureChunk[] {
    const held = this.held
    this.held = []
    const merged: DictationCaptureChunk[] = []
    let parts: Uint8Array[] = []
    let bytes = 0
    let droppedBytes = 0
    const flush = () => {
      if (parts.length === 0 && droppedBytes === 0) {
        return
      }
      const data = new Uint8Array(bytes)
      let offset = 0
      for (const part of parts) {
        data.set(part, offset)
        offset += part.byteLength
      }
      merged.push({ data, droppedBytes })
      parts = []
      bytes = 0
      droppedBytes = 0
    }
    for (const chunk of held) {
      if (bytes > 0 && bytes + chunk.data.byteLength > MAX_DICTATION_AUDIO_CHUNK_BYTES) {
        flush()
      }
      parts.push(chunk.data)
      bytes += chunk.data.byteLength
      droppedBytes += chunk.droppedBytes
    }
    flush()
    return merged
  }

  clear(): void {
    this.held = []
  }
}
