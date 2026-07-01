import { WebSocket, type RawData } from 'ws'
import { resampleToRate } from './stt-audio-resample'
import { combineChunks, encodePcm16Wav } from './pcm-wav-encoder'
import type { SttEventSink } from './stt-service'

export const SARVAM_TRANSCRIPTION_MODEL_BY_ID: Record<string, string> = {
  'sarvam-saaras-v3': 'saaras:v3'
}

const SARVAM_STREAMING_URL = 'wss://api.sarvam.ai/speech-to-text/ws'
const SARVAM_STREAMING_SAMPLE_RATE = 16000
// ~200ms of 16kHz audio per frame — cuts message rate versus the ~85ms mic
// chunks without adding meaningful latency for dictation.
const FRAME_SAMPLES = SARVAM_STREAMING_SAMPLE_RATE / 5
// Bound how long stop() waits for trailing finalized segments after flushing so
// an unacknowledged flush cannot wedge the dictation lifecycle.
const FLUSH_DRAIN_MS = 3000
// Once flushed segments start arriving, resolve stop() this long after the last
// one instead of waiting out FLUSH_DRAIN_MS — keeps the common stop fast while
// still catching multiple trailing segments.
const FLUSH_SETTLE_MS = 400
// Drop-to-buffer guard so a stalled socket cannot grow unbounded in memory.
const MAX_BUFFERED_BYTES = 1_000_000

type SarvamStreamMessage = {
  type?: string
  data?: {
    transcript?: unknown
    error?: unknown
    code?: unknown
  }
}

export function sanitizeSarvamTranscriptionErrorMessage(message: string, apiKey?: string): string {
  let sanitized = message
  // Why: Sarvam authenticates with a bare `api-subscription-key` header value
  // (no `sk-`/`Bearer` shape), so the OpenAI redaction patterns miss it — redact
  // the exact key if we hold one, then map known auth failures to a friendly line.
  if (apiKey) {
    sanitized = sanitized.split(apiKey).join('[redacted]')
  }
  if (/invalid[_ ]api[_ ]key|authentication|api-subscription-key/i.test(sanitized)) {
    return 'Incorrect Sarvam API key provided.'
  }
  sanitized = sanitized.trim()
  return sanitized || 'Sarvam transcription request failed'
}

// Streams dictation audio to Sarvam's real-time WebSocket, emitting each
// finalized (VAD/flush-driven) segment as one `final` event. Conforms to
// CloudTranscriptionSession (structural).
export class SarvamTranscriptionSession {
  private socket: WebSocket | null = null
  private pending: Float32Array[] = []
  private pendingLength = 0
  private stopping = false
  private closed = false
  private resolveDrain: (() => void) | null = null
  private flushSettleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly modelId: string,
    private readonly readApiKey: () => string,
    private readonly sink: SttEventSink
  ) {}

  async start(): Promise<void> {
    const apiModel = SARVAM_TRANSCRIPTION_MODEL_BY_ID[this.modelId]
    if (!apiModel) {
      throw new Error(`Unknown Sarvam transcription model: ${this.modelId}`)
    }
    const apiKey = this.readApiKey()
    const params = new URLSearchParams({
      model: apiModel,
      // Auto-detect the spoken language across Sarvam's supported languages.
      'language-code': 'unknown',
      mode: 'transcribe',
      sample_rate: String(SARVAM_STREAMING_SAMPLE_RATE),
      // Snappier end-of-speech (0.5s boundary) suits push-to-talk dictation.
      high_vad_sensitivity: 'true',
      // Required so stop()'s `flush` message finalizes the trailing utterance;
      // without it the server ignores the flush and the last words are lost.
      flush_signal: 'true'
    })
    const socket = new WebSocket(`${SARVAM_STREAMING_URL}?${params.toString()}`, {
      headers: { 'api-subscription-key': apiKey }
    })
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        socket.off('error', onError)
        socket.off('unexpected-response', onUnexpected)
        socket.off('close', onCloseBeforeOpen)
        this.attachStreamListeners(socket, apiKey)
        this.drain()
        resolve()
      }
      const fail = (message: string): void => {
        socket.off('open', onOpen)
        socket.off('error', onError)
        socket.off('unexpected-response', onUnexpected)
        socket.off('close', onCloseBeforeOpen)
        this.teardown()
        reject(new Error(sanitizeSarvamTranscriptionErrorMessage(message, apiKey)))
      }
      const onError = (error: Error): void => fail(error.message)
      const onUnexpected = (_req: unknown, res: { statusCode?: number }): void =>
        fail(`Sarvam streaming handshake failed with status ${res?.statusCode ?? 'unknown'}`)
      const onCloseBeforeOpen = (code: number, reason: Buffer): void =>
        fail(`Sarvam streaming connection closed before ready (${code}) ${reason.toString()}`)

      socket.once('open', onOpen)
      socket.once('error', onError)
      socket.once('unexpected-response', onUnexpected)
      socket.once('close', onCloseBeforeOpen)
    })
  }

  feedAudio(samples: Float32Array, sampleRate: number): void {
    if (this.closed) {
      return
    }
    const normalized = resampleToRate(samples, sampleRate, SARVAM_STREAMING_SAMPLE_RATE)
    this.pending.push(new Float32Array(normalized))
    this.pendingLength += normalized.length
    if (this.pendingLength >= FRAME_SAMPLES) {
      this.drain()
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    try {
      this.drain(true)
      const socket = this.socket
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'flush' }))
        await this.waitForDrain()
      }
    } catch (error) {
      this.sink({
        type: 'error',
        error: sanitizeSarvamTranscriptionErrorMessage(
          error instanceof Error ? error.message : String(error)
        )
      })
    } finally {
      this.teardown()
    }
  }

  private attachStreamListeners(socket: WebSocket, apiKey: string): void {
    socket.on('message', (raw: RawData) => this.handleMessage(raw, apiKey))
    socket.on('error', (error: Error) => {
      if (this.stopping) {
        return
      }
      this.sink({
        type: 'error',
        error: sanitizeSarvamTranscriptionErrorMessage(error.message, apiKey)
      })
      this.teardown()
    })
    socket.on('close', (code: number, reason: Buffer) => {
      // Why: a normal (1000) close or a stop-initiated close is expected; any
      // other mid-stream close means the dictation failed and must surface.
      if (!this.stopping && code !== 1000) {
        this.sink({
          type: 'error',
          error: sanitizeSarvamTranscriptionErrorMessage(
            `Sarvam streaming connection closed (${code}) ${reason.toString()}`,
            apiKey
          )
        })
      }
      // Why: once the socket is gone the session is finished — tear down (marks
      // `closed`, drops the socket, resolves any pending drain) so later
      // feedAudio() can't keep buffering into a dead connection.
      this.teardown()
    })
  }

  private handleMessage(raw: RawData, apiKey: string): void {
    let message: SarvamStreamMessage
    try {
      message = JSON.parse(raw.toString()) as SarvamStreamMessage
    } catch {
      return
    }
    if (message.type === 'data' && typeof message.data?.transcript === 'string') {
      // Each data message is one finalized segment; the renderer accumulates and
      // handles inter-segment spacing, so emit only this segment's text.
      const text = message.data.transcript.trim()
      if (text) {
        this.sink({ type: 'final', text })
      }
      // After a flush each trailing segment restarts a short settle window so
      // stop() resolves once segments stop arriving rather than at the hard cap.
      this.nudgeFlushDrain()
      return
    }
    if (message.type === 'error') {
      const detail =
        typeof message.data?.error === 'string' ? message.data.error : 'Sarvam streaming error'
      this.sink({ type: 'error', error: sanitizeSarvamTranscriptionErrorMessage(detail, apiKey) })
    }
  }

  private drain(force = false): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN || this.pendingLength === 0) {
      return
    }
    if (!force && socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Why: drop the queued frames rather than hold them — otherwise each later
      // feedAudio() keeps appending while the socket stays backed up, so the
      // "bounded memory" guard would never actually bound anything.
      this.pending = []
      this.pendingLength = 0
      return
    }
    const combined = combineChunks(this.pending)
    this.pending = []
    this.pendingLength = 0
    const wav = encodePcm16Wav(combined, SARVAM_STREAMING_SAMPLE_RATE)
    socket.send(
      JSON.stringify({
        audio: {
          data: wav.toString('base64'),
          sample_rate: String(SARVAM_STREAMING_SAMPLE_RATE),
          encoding: 'audio/wav'
        }
      })
    )
  }

  private waitForDrain(): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        this.resolveDrain = null
        if (this.flushSettleTimer) {
          clearTimeout(this.flushSettleTimer)
          this.flushSettleTimer = null
        }
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, FLUSH_DRAIN_MS)
      timer.unref?.()
      this.resolveDrain = finish
    })
  }

  private nudgeFlushDrain(): void {
    const resolve = this.resolveDrain
    if (!resolve) {
      return
    }
    if (this.flushSettleTimer) {
      clearTimeout(this.flushSettleTimer)
    }
    this.flushSettleTimer = setTimeout(resolve, FLUSH_SETTLE_MS)
    this.flushSettleTimer.unref?.()
  }

  private teardown(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.resolveDrain?.()
    const socket = this.socket
    this.socket = null
    if (!socket) {
      return
    }
    socket.removeAllListeners()
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000)
    } else {
      socket.terminate()
    }
  }
}
