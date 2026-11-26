import type * as TranscribeCpp from 'transcribe-cpp'
import { SILENCE_PROBABILITY, type VadStream } from './stt-vad-pause-segmenter'

// Commit once the text has not changed for twice this much decoded audio, covering all but this much:
// a CPU replay then starts in the quiet, clear of the last word posted and the next one.
const QUIET_MARGIN_MS = 1000
// Silence this long sits between words, so a stream ended there cuts none in two.
const PAUSE_SECONDS = 0.15

export type LiveDecodeUpdate =
  /** Text since the last commit, which may still change. */
  | { type: 'partial'; text: string }
  /** The speaker went quiet: `text` is new since the last commit, and `covered` (stream position) accounts for it. */
  | { type: 'quiet'; text: string; covered: number }

/**
 * A streaming model's decode for one dictation, fed every chunk so its text keeps context across pauses.
 * transcribe-cpp's own committed text stalls for good after the first sentence (0.4.1, Nemotron), so the
 * text is committed here instead, when the speaker goes quiet; this model family never revises emitted text.
 */
export class LiveDecode {
  private native: TranscribeCpp.Stream | null = null
  /** Stream position (model-rate samples) where `native` began. */
  private from = 0
  private text = ''
  /** Characters of `text` already committed. */
  private committed = 0
  /** How much audio `native` had decoded (ms) when its text last changed. */
  private changedAtMs = 0
  /** Silero frames of silence at the end of the audio so far. */
  private silentFrames = 0

  private readonly pauseFrames: number

  /** Without Silero the stream is never known to be at a pause. */
  constructor(
    private readonly session: TranscribeCpp.Session,
    private readonly options: TranscribeCpp.StreamOptions,
    private readonly modelRate: number,
    private silero: { vad: VadStream; frameSamples: number } | null
  ) {
    this.pauseFrames = silero ? Math.ceil((PAUSE_SECONDS * modelRate) / silero.frameSamples) : 0
  }

  /** A running native stream holds the whole model; nothing else can decode until it ends. */
  get holdsModel(): boolean {
    return this.native !== null
  }

  /** The speaker is pausing, so ending the stream now cuts no word in two. */
  get atPause(): boolean {
    return !!this.silero && this.silentFrames >= this.pauseFrames
  }

  /** `position`: stream position (model-rate samples) at the end of `samples`. */
  async feed(samples: Float32Array, position: number): Promise<LiveDecodeUpdate | null> {
    // transcribe-cpp rejects an empty feed, and a phone can send one.
    if (samples.length === 0) {
      return null
    }
    if (!this.native) {
      this.native = await this.session.stream(this.options)
      this.from = position - samples.length
      this.text = ''
      this.committed = 0
      this.changedAtMs = 0
    }
    await this.notePauses(samples)
    const native = this.native
    const update = await native.feed(samples).catch((error: unknown) => {
      // A failed stream has let go of the model; the next feed starts a new one.
      this.reset()
      throw error
    })
    const text = update.resultChanged ? native.text.full : this.text
    if (text !== this.text) {
      this.text = text
      this.changedAtMs = update.audioCommittedMs
      return { type: 'partial', text: text.slice(this.committed).trim() }
    }
    if (update.audioCommittedMs - this.changedAtMs < 2 * QUIET_MARGIN_MS) {
      return null
    }
    const quietAt = update.audioCommittedMs - QUIET_MARGIN_MS
    return {
      type: 'quiet',
      text: this.commit(),
      covered: this.from + Math.round((quietAt * this.modelRate) / 1000)
    }
  }

  /** Ends the native stream, returning its uncommitted text, or null when none was running; the next feed starts another. */
  async end(finalize: boolean): Promise<string | null> {
    const native = this.native
    if (!native) {
      return null
    }
    this.native = null
    try {
      if (finalize) {
        await native.finalize()
        this.text = native.text.full
      }
    } finally {
      native.reset()
    }
    return this.commit()
  }

  private async notePauses(samples: Float32Array): Promise<void> {
    try {
      for (const probability of (await this.silero?.vad.streamFeed(samples))?.probs ?? []) {
        this.silentFrames = probability < SILENCE_PROBABILITY ? this.silentFrames + 1 : 0
      }
    } catch (error) {
      // Optional, as for pause-cut dictation: without it the stream restarts only at the hard bound.
      console.warn('[speech] Silero VAD failed; this dictation restarts only at its bound:', error)
      this.silero = null
    }
  }

  reset(): void {
    this.native?.reset()
    this.native = null
  }

  private commit(): string {
    const text = this.text.slice(this.committed).trim()
    this.committed = this.text.length
    return text
  }
}

/** Runs one decode step on silence, so the stream path's GPU pipelines compile before the first dictation. */
export async function warmUpLiveDecode(
  session: TranscribeCpp.Session,
  options: TranscribeCpp.StreamOptions,
  modelRate: number
): Promise<void> {
  const stream = await session.stream(options)
  try {
    // Longer than a streaming family's decode step (Nemotron's is 1.12 s).
    await stream.feed(new Float32Array(Math.round(modelRate * 1.5)))
  } finally {
    stream.reset()
  }
}
