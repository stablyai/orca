import type WebSocket from 'ws'
import { CloudAudioResampler, cloudAudioSeconds, encodePcm16 } from './cloud-speech-audio-encoding'
import { describeProviderFailure, redactCloudSpeechSecrets } from './cloud-speech-provider-errors'
import type { CloudSpeechSession, CloudSpeechSessionOptions } from './cloud-speech-session'

const MAX_REALTIME_AUDIO_SECONDS = 30 * 60
export const REALTIME_FINISH_TIMEOUT_MS = 10_000
export const MAX_REALTIME_BUFFERED_BYTES = 2 * 1024 * 1024
// Why: a provider that opens but never acknowledges the session would otherwise eat the recording.
export const REALTIME_ACCEPT_TIMEOUT_MS = 15_000

/**
 * Shared WebSocket lifecycle for streaming providers: connect at start without blocking
 * 'ready', queue audio until the provider handshake completes, publish the running transcript
 * as partials, and on finish ask the provider to flush and wait (bounded) for its final text.
 */
export abstract class RealtimeCloudSpeechSession implements CloudSpeechSession {
  protected socket: WebSocket | null = null
  protected readonly language: string | undefined
  private readonly pending: Buffer[] = []
  private accepting = false
  private closed = false
  private failure: string | null = null
  private audioSeconds = 0
  private lastPartial = ''
  private settleFinish: (() => void) | null = null
  private finishSignaled = false
  private acceptTimer: ReturnType<typeof setTimeout> | null = null
  private apiKey = ''
  private readonly resampler = new CloudAudioResampler()

  constructor(
    protected readonly label: string,
    private readonly options: CloudSpeechSessionOptions
  ) {
    this.language = options.language
  }

  /** Opens the socket; called by the factory right after construction. */
  start(): void {
    let socket: WebSocket
    try {
      this.apiKey = this.options.readApiKey()
      socket = this.createSocket(this.apiKey)
    } catch (error) {
      // Why: throwing lets start reject instead of reporting 'ready' for a dead session; ws can echo the key.
      this.close()
      throw new Error(describeProviderFailure(this.label, error))
    }
    this.socket = socket
    socket.on('open', () => this.onOpen())
    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.handleText(data.toString())
      }
    })
    socket.on('unexpected-response', (request, response) => {
      const status = response.statusCode ?? 0
      request.destroy()
      this.fail(
        status === 401 || status === 403
          ? `${this.label} rejected the API key (${status}).`
          : `${this.label} refused the streaming connection (${status}).`
      )
    })
    socket.on('error', (error) => this.fail(describeProviderFailure(this.label, error)))
    socket.on('close', (code, reason) => this.onSocketClose(code, reason.toString()))
    this.acceptTimer = setTimeout(
      () => this.fail(`${this.label} did not start the stream in time.`),
      REALTIME_ACCEPT_TIMEOUT_MS
    )
    this.acceptTimer.unref?.()
  }

  feedAudio(samples: Float32Array, sampleRate: number): void {
    if (this.closed || this.failure) {
      return
    }
    const nextSeconds = this.audioSeconds + cloudAudioSeconds(samples.length, sampleRate)
    if (nextSeconds > MAX_REALTIME_AUDIO_SECONDS) {
      throw new Error('Real-time transcription is limited to 30 minutes per dictation')
    }
    const pcm = encodePcm16(this.resampler.push(samples, sampleRate))
    this.audioSeconds = nextSeconds
    // Why: a chunk too short to complete an output sample waits in the resampler; an empty frame would end some streams.
    if (pcm.length === 0) {
      return
    }
    const socket = this.accepting ? this.openSocket() : null
    if (socket) {
      // Why: a stalled socket would otherwise buffer the whole dictation in memory.
      if (socket.bufferedAmount + pcm.length > MAX_REALTIME_BUFFERED_BYTES) {
        this.fail(`${this.label} connection is too slow.`)
        return
      }
      this.sendAudio(pcm)
    } else {
      this.pending.push(pcm)
    }
  }

  async finish(): Promise<string> {
    if (this.closed) {
      return this.finalTranscript().trim()
    }
    if (this.audioSeconds === 0) {
      this.close()
      return ''
    }
    if (!this.failure && this.socket) {
      await this.waitForSettle(() => {
        if (this.accepting) {
          this.signalEnd()
        }
      })
      // Why: audio queued for a provider that never accepted was dropped; say so instead of "no speech".
      if (!this.accepting) {
        this.fail(`${this.label} did not start the stream in time.`)
      }
    }
    this.close()
    // Why: a mid-stream failure was already reported through the sink; keep what was committed.
    return this.finalTranscript().trim()
  }

  cancel(): void {
    this.close()
  }

  protected abstract createSocket(apiKey: string): WebSocket
  /** Sends any configuration and calls markAccepting() once audio may flow. */
  protected abstract onOpen(): void
  protected abstract handleMessage(message: Record<string, unknown>): void
  protected abstract sendAudio(pcm: Buffer): void
  /** Asks the provider to flush; it must eventually call markFinished(). */
  protected abstract sendEnd(): void
  /** The whole transcript so far (committed plus in-progress). */
  protected abstract runningTranscript(): string
  /** The committed transcript once the provider has flushed. */
  protected abstract finalTranscript(): string

  /** Releases provider-side timers; the socket is already detached. */
  protected onClosed(): void {}

  protected markAccepting(): void {
    if (this.accepting || this.closed) {
      return
    }
    this.accepting = true
    this.clearAcceptTimer()
    for (const pcm of this.pending.splice(0)) {
      this.sendAudio(pcm)
    }
    if (this.settleFinish) {
      this.signalEnd()
    }
  }

  protected markFinished(): void {
    this.settleFinish?.()
  }

  protected publishPartial(): void {
    const text = this.runningTranscript().trim()
    if (this.closed || this.finishSignaled || text === this.lastPartial) {
      return
    }
    this.lastPartial = text
    this.options.sink({ type: 'partial', text })
  }

  protected fail(message: string): void {
    if (this.failure || this.closed) {
      return
    }
    // Why: providers can echo a key of any shape, which the pattern redaction would miss.
    const withoutKey = this.apiKey ? message.split(this.apiKey).join('[redacted]') : message
    this.failure = redactCloudSpeechSecrets(withoutKey) || `${this.label} streaming failed.`
    this.options.sink({ type: 'error', error: this.failure })
    this.settleFinish?.()
    this.close()
  }

  protected sendJson(payload: unknown): void {
    this.openSocket()?.send(JSON.stringify(payload))
  }

  private openSocket(): WebSocket | null {
    const socket = this.socket
    return socket && socket.readyState === socket.OPEN ? socket : null
  }

  private clearAcceptTimer(): void {
    if (this.acceptTimer) {
      clearTimeout(this.acceptTimer)
      this.acceptTimer = null
    }
  }

  private signalEnd(): void {
    if (this.finishSignaled) {
      return
    }
    this.finishSignaled = true
    this.sendEnd()
  }

  private waitForSettle(begin: () => void): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, REALTIME_FINISH_TIMEOUT_MS)
      function done(): void {
        clearTimeout(timer)
        resolve()
      }
      this.settleFinish = done
      begin()
    })
  }

  private handleText(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      this.handleMessage(Object.fromEntries(Object.entries(parsed)))
    }
  }

  private onSocketClose(code: number, reason: string): void {
    if (this.closed) {
      return
    }
    // Why: any close before finish (even 1000, e.g. a provider session limit) drops later audio.
    if (!this.finishSignaled) {
      this.fail(`${this.label} closed the stream (${code}${reason ? `: ${reason}` : ''}).`)
      return
    }
    this.settleFinish?.()
  }

  private close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.pending.length = 0
    this.clearAcceptTimer()
    this.onClosed()
    // Why: cancel() during finish() must not leave finish waiting for the timeout.
    this.settleFinish?.()
    const socket = this.socket
    this.socket = null
    if (!socket) {
      return
    }
    socket.removeAllListeners()
    // Why: a late socket error after removeAllListeners would otherwise crash the main process.
    socket.on('error', () => {})
    if (socket.readyState === socket.OPEN) {
      socket.close(1000)
    } else {
      socket.terminate()
    }
  }
}
