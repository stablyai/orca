import { spawnProcess } from '../../shared/child-process/run-process'
import { getAppleSpeechHelperPath } from './apple-speech-helper-binary'
import { createAppleSpeechEventReader, describeAppleSpeechError } from './apple-speech-events'
import { resampleToRate } from './stt-audio-resample'

/** What the helper's `--sample-rate` is told; everything is resampled to it first. */
const APPLE_SPEECH_SAMPLE_RATE = 16000
const START_TIMEOUT_MS = 15_000
const FINISH_TIMEOUT_MS = 20_000

export type AppleSpeechEmit = (
  event:
    | { type: 'partial'; text?: string }
    | { type: 'final'; text?: string }
    | {
        type: 'error'
        error?: string
      }
) => void

/**
 * Drives the macOS SpeechAnalyzer helper for one dictation.
 *
 * Unlike the cloud session, transcripts arrive while the user is still talking,
 * so partial and final segments are pushed through `emit` as they land and
 * `finish` only waits for the helper to drain.
 */
export class AppleSpeechSession {
  private child: ReturnType<typeof spawnProcess> | null = null
  private closed = false
  private finishing: Promise<string> | null = null

  constructor(private readonly emit: AppleSpeechEmit) {}

  async start(): Promise<void> {
    const helperPath = getAppleSpeechHelperPath()
    if (!helperPath) {
      throw new Error('Apple Speech is unavailable on this Mac.')
    }
    const child = spawnProcess({
      program: helperPath,
      args: ['transcribe', '--sample-rate', String(APPLE_SPEECH_SAMPLE_RATE)],
      timeoutMs: null
    })
    this.child = child
    // Why all three: spawnProcess hands back raw streams whose 'error' events
    // the caller owns, and an unhandled one is an uncaught exception that takes
    // the main process down mid-dictation.
    //
    // stdin is expected to break when the helper exits first; a broken stdout
    // instead means transcripts stop arriving, so it ends the dictation.
    child.stdin.on('error', () => {})
    const failOnStreamError = (): void => {
      child.kill()
    }
    child.stdout.on('error', failOnStreamError)
    child.stderr.on('error', failOnStreamError)
    child.stderr.resume()

    let ready = false
    let startFailure: string | null = null
    let reportedError = false
    let onReady: (() => void) | null = null
    const reader = createAppleSpeechEventReader((event) => {
      switch (event.type) {
        case 'ready':
          ready = true
          onReady?.()
          break
        case 'partial':
        case 'final':
          this.emit({ type: event.type, text: event.text })
          break
        case 'error': {
          const message = describeAppleSpeechError(event)
          startFailure ??= message
          if (ready) {
            reportedError = true
            this.emit({ type: 'error', error: message })
          }
          onReady?.()
          break
        }
        case 'status':
        case 'progress':
        case 'installed':
        case 'stopped':
          // Install-time and shutdown events; the stop path reports those.
          break
      }
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => reader.push(chunk))
    child.once('close', () => {
      this.closed = true
      reader.flush()
      onReady?.()
      // Why: a helper that dies mid-dictation would otherwise leave the pill
      // listening while every later frame is dropped. The error stops the UI.
      if (ready && !reportedError && !this.finishing) {
        this.emit({ type: 'error', error: 'Apple Speech stopped unexpectedly.' })
      }
    })

    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout
      const settle = (error?: Error): void => {
        if (onReady === null) {
          return
        }
        onReady = null
        clearTimeout(timer)
        if (error) {
          reject(error)
          return
        }
        resolve()
      }
      timer = setTimeout(() => {
        settle(new Error('Apple Speech did not start in time.'))
      }, START_TIMEOUT_MS)
      onReady = () => {
        settle(ready ? undefined : new Error(startFailure ?? 'Apple Speech failed to start.'))
      }
      if (ready || startFailure || this.closed) {
        onReady()
      }
    }).catch((error: unknown) => {
      this.kill()
      throw error
    })
  }

  feedAudio(samples: Float32Array, sampleRate: number): void {
    const child = this.child
    if (!child || child.stdin.destroyed || this.finishing) {
      return
    }
    const normalized = resampleToRate(samples, sampleRate, APPLE_SPEECH_SAMPLE_RATE)
    child.stdin.write(Buffer.from(normalized.buffer, normalized.byteOffset, normalized.byteLength))
  }

  /**
   * Closes the helper's audio input and waits for its last final segment.
   * Segments were already emitted, so the resolved string is always empty —
   * it exists to match the shape the stop path shares with the cloud session.
   */
  finish(): Promise<string> {
    if (this.finishing) {
      return this.finishing
    }
    const child = this.child
    if (!child || this.closed) {
      this.child = null
      return Promise.resolve('')
    }
    this.finishing = new Promise<string>((resolve) => {
      let timer: NodeJS.Timeout
      const done = (): void => {
        clearTimeout(timer)
        this.child = null
        resolve('')
      }
      timer = setTimeout(() => {
        // The helper owes us a last final segment; past this it is hung.
        this.kill()
        done()
      }, FINISH_TIMEOUT_MS)
      child.once('close', done)
      child.stdin.end()
    })
    return this.finishing
  }

  private kill(): void {
    const child = this.child
    this.child = null
    child?.kill()
  }
}
