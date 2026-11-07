import type * as TranscribeCpp from 'transcribe-cpp'
import { OfflineAudioChunker } from './stt-offline-audio-chunker'

// Silero's own defaults: a frame at or above this is speech; inside speech, one below the second is silence.
const SPEECH_PROBABILITY = 0.5
const SILENCE_PROBABILITY = 0.35
// A pause this long commits the phrase before it. Shorter cuts split phrases, and each piece gets its own capital and full stop.
export const VAD_PAUSE_SECONDS = 0.6
// Silence kept ahead of detected speech so a soft first syllable isn't clipped.
const SPEECH_PREROLL_SECONDS = 0.4

export type VadStream = Pick<TranscribeCpp.VadSession, 'streamFeed' | 'streamFlush'>

/**
 * Cuts one dictation's audio at pauses so an offline model can decode each phrase as it ends, and drops the
 * silence between phrases. Phrases longer than the decode bound still split at their quietest point.
 */
export class VadPauseSegmenter {
  private readonly phrase: OfflineAudioChunker
  private readonly pauseFrames: number
  private readonly prerollSamples: number
  private unscored = new Float32Array(0)
  private preroll: Float32Array[] = []
  private prerollLength = 0
  private inSpeech = false
  private silentFrames = 0

  constructor(
    private readonly vad: VadStream,
    sampleRate: number,
    private readonly frameSamples: number
  ) {
    this.phrase = new OfflineAudioChunker(sampleRate)
    this.pauseFrames = Math.ceil((VAD_PAUSE_SECONDS * sampleRate) / frameSamples)
    this.prerollSamples = Math.round(SPEECH_PREROLL_SECONDS * sampleRate)
  }

  /** Samples pushed but neither returned nor dropped as silence. */
  get heldSamples(): number {
    return this.unscored.length + this.prerollLength + this.phrase.heldSamples
  }

  /** Return the phrases that ended (or reached the decode bound) within these samples. */
  async push(samples: Float32Array): Promise<Float32Array[]> {
    this.unscored = concat(this.unscored, samples)
    // The binding borrows the PCM until the call settles, so it gets its own copy.
    const scored = await this.vad.streamFeed(new Float32Array(samples))
    return this.route(scored.probs)
  }

  /** Return the rest of an open phrase; trailing silence is dropped. */
  async flush(): Promise<Float32Array[]> {
    const scored = await this.vad.streamFlush()
    const ready = this.route(scored.probs, true)
    const rest = this.inSpeech ? this.phrase.flush() : null
    this.inSpeech = false
    this.preroll = []
    this.prerollLength = 0
    return rest ? [...ready, rest] : ready
  }

  private route(probs: readonly number[], last = false): Float32Array[] {
    const ready: Float32Array[] = []
    let offset = 0
    for (const probability of probs) {
      // The flushed last frame is zero padded past the real audio.
      const end = Math.min(this.unscored.length, offset + this.frameSamples)
      const frame = this.unscored.subarray(offset, end)
      offset = end
      if (!this.inSpeech && probability >= SPEECH_PROBABILITY) {
        this.inSpeech = true
        this.silentFrames = 0
        for (const held of this.preroll) {
          ready.push(...this.phrase.push(held))
        }
        this.preroll = []
        this.prerollLength = 0
      }
      if (!this.inSpeech) {
        this.holdPreroll(frame)
        continue
      }
      ready.push(...this.phrase.push(frame))
      this.silentFrames = probability < SILENCE_PROBABILITY ? this.silentFrames + 1 : 0
      if (this.silentFrames >= this.pauseFrames) {
        this.inSpeech = false
        const rest = this.phrase.flush()
        if (rest) {
          ready.push(rest)
        }
      }
    }
    this.unscored = last ? new Float32Array(0) : this.unscored.slice(offset)
    return ready
  }

  private holdPreroll(frame: Float32Array): void {
    this.preroll.push(frame.slice())
    this.prerollLength += frame.length
    while (
      this.preroll.length > 1 &&
      this.prerollLength - this.preroll[0].length >= this.prerollSamples
    ) {
      this.prerollLength -= this.preroll[0].length
      this.preroll.shift()
    }
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) {
    return b.slice()
  }
  const out = new Float32Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}
