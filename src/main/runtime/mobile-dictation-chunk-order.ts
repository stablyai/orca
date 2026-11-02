import { MOBILE_DICTATION_MAX_PENDING_AUDIO_BYTES } from '../../shared/rpc-contract/speech-params'

export type MobileDictationChunk = { audioBase64: string; sampleRate: number }

// Past what the phone holds through a reconnect, a missing chunk is given up on.
const MAX_HELD_BASE64_LENGTH = Math.ceil(MOBILE_DICTATION_MAX_PENDING_AUDIO_BYTES / 3) * 4
// The grace's worth of native microphone events, one chunk per ~32ms; tiny chunks must not pile up under the byte cap.
const MAX_HELD_CHUNKS = 1_000

// A chunk resent after a drop can land behind audio captured later, so release audio in seq order and each seq once.
export class MobileDictationChunkOrder {
  private nextSeq = 0
  private heldLength = 0
  private readonly held = new Map<number, MobileDictationChunk>()

  accept(seq: number, chunk: MobileDictationChunk): MobileDictationChunk[] {
    if (seq < this.nextSeq || this.held.has(seq)) {
      return []
    }
    this.held.set(seq, chunk)
    this.heldLength += chunk.audioBase64.length
    const ready = this.releaseInOrder()
    while (this.heldLength > MAX_HELD_BASE64_LENGTH || this.held.size > MAX_HELD_CHUNKS) {
      this.nextSeq = Infinity
      for (const held of this.held.keys()) {
        this.nextSeq = Math.min(this.nextSeq, held)
      }
      ready.push(...this.releaseInOrder())
    }
    return ready
  }

  private releaseInOrder(): MobileDictationChunk[] {
    const ready: MobileDictationChunk[] = []
    for (let next = this.held.get(this.nextSeq); next; next = this.held.get(this.nextSeq)) {
      ready.push(next)
      this.held.delete(this.nextSeq)
      this.heldLength -= next.audioBase64.length
      this.nextSeq += 1
    }
    return ready
  }

  // What is still held when the phone finishes, skipping chunks that never came.
  drain(): MobileDictationChunk[] {
    const rest = [...this.held].sort(([a], [b]) => a - b).map(([, chunk]) => chunk)
    this.held.clear()
    this.heldLength = 0
    return rest
  }
}
