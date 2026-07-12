import WebSocket from 'ws'
import { resampleToRate } from './stt-audio-resample'
import type { SttEventSink } from './stt-service-types'
import { encodePcm16Le } from './pcm16-audio-encoding'
import {
  formatSonioxServerError,
  sanitizeSonioxConnectionDiagnostic
} from './soniox-transcription-error'
import {
  isSonioxControlToken,
  parseSonioxResponse,
  type SonioxResponse,
  type SonioxToken
} from './soniox-transcription-response'
import { createSonioxStartRequest, SONIOX_SAMPLE_RATE } from './soniox-transcription-config'
import type { SonioxSocket } from './soniox-transcription-socket'

export const SONIOX_WEBSOCKET_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
const SONIOX_FINISH_TIMEOUT_MS = 60_000
const SONIOX_START_TIMEOUT_MS = 60_000
const SONIOX_KEEPALIVE_MS = 10_000
const MAX_QUEUED_AUDIO_SECONDS = 30
const MAX_SOCKET_BUFFER_BYTES = 1024 * 1024

type SocketFactory = (url: string) => SonioxSocket
type QueuedAudio = { buffer: Buffer; durationMs: number }

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer) {
    clearTimeout(timer)
  }
  return null
}

export class SonioxTranscriptionSession {
  private socket: SonioxSocket | null = null
  private started = false
  private finishing = false
  private finished = false
  private reportedError = false
  private finishResolve: (() => void) | null = null
  private finishReject: ((error: Error) => void) | null = null
  private finishTimeout: ReturnType<typeof setTimeout> | null = null
  private startTimeout: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null
  private audioPaceTimer: ReturnType<typeof setTimeout> | null = null
  private audioQueue: QueuedAudio[] = []
  private queuedAudioSeconds = 0
  private endFrameSent = false
  private finishPromise: Promise<string> | null = null
  private apiKey = ''

  constructor(
    private readonly modelId: string,
    private readonly readApiKey: () => string,
    private readonly sink: SttEventSink,
    private readonly socketFactory: SocketFactory = (url) => new WebSocket(url)
  ) {}

  start(): Promise<void> {
    let startRequest: ReturnType<typeof createSonioxStartRequest>
    let socket: SonioxSocket
    try {
      this.apiKey = this.readApiKey()
      startRequest = createSonioxStartRequest(this.modelId, this.apiKey)
      socket = this.socketFactory(SONIOX_WEBSOCKET_URL)
    } catch (error) {
      return Promise.reject(error)
    }
    this.socket = socket

    return new Promise<void>((resolve, reject) => {
      let startSettled = false
      // Why: closing a failed startup can emit later socket events that must not
      // become runtime errors or revive the rejected session.
      let startupFailed = false
      const rejectStart = (error: Error): boolean => {
        if (startSettled) {
          return false
        }
        startSettled = true
        startupFailed = true
        this.startTimeout = clearTimer(this.startTimeout)
        reject(error)
        return true
      }
      socket.on('open', () => {
        if (startupFailed) {
          return
        }
        socket.send(JSON.stringify(startRequest))
        this.started = true
        this.pumpAudioQueue()
        startSettled = true
        this.startTimeout = clearTimer(this.startTimeout)
        this.scheduleKeepalive()
        resolve()
      })
      socket.on('message', (data) => this.handleMessage(data))
      socket.on('error', (error) => {
        if (startupFailed) {
          return
        }
        this.logConnectionDiagnostic(error)
        if (!startSettled) {
          if (rejectStart(new Error('Soniox connection failed.'))) {
            socket.close()
          }
          return
        }
        this.reportError('Soniox connection failed.')
      })
      socket.on('close', () => {
        if (!startSettled) {
          rejectStart(new Error('Soniox connection closed before transcription started'))
        }
        if (!startupFailed) {
          if (this.finishing && !this.finished && !this.reportedError) {
            this.rejectFinish(new Error('Soniox connection closed before the final response'))
          } else if (!this.finishing && !this.reportedError) {
            this.reportError('Soniox connection closed unexpectedly')
          }
        }
        this.clearTimers()
        socket.removeAllListeners()
        if (this.socket === socket) {
          this.socket = null
        }
      })
      this.startTimeout = setTimeout(() => {
        if (rejectStart(new Error('Soniox connection timed out while starting'))) {
          socket.close()
        }
      }, SONIOX_START_TIMEOUT_MS)
      this.startTimeout.unref?.()
    })
  }

  feedAudio(samples: Float32Array, sampleRate: number): void {
    if (this.finishing || !this.socket) {
      return
    }
    const normalized = resampleToRate(samples, sampleRate, SONIOX_SAMPLE_RATE)
    if (normalized.length === 0) {
      // Why: Soniox interprets an empty WebSocket frame as end-of-stream.
      return
    }
    const durationSeconds = normalized.length / SONIOX_SAMPLE_RATE
    if (this.queuedAudioSeconds + durationSeconds > MAX_QUEUED_AUDIO_SECONDS) {
      const error = new Error('Soniox audio queue exceeded 30 seconds')
      this.reportError(error.message)
      throw error
    }
    this.audioQueue.push({
      buffer: encodePcm16Le(normalized),
      durationMs: durationSeconds * 1000
    })
    this.queuedAudioSeconds += durationSeconds
    if (this.started) {
      this.pumpAudioQueue()
    }
  }

  finish(): Promise<string> {
    if (this.finished || this.reportedError || !this.socket) {
      return Promise.resolve('')
    }
    if (!this.started) {
      // Why: startup cancellation can race a CONNECTING socket; sending the
      // end frame before open throws and can leave a provider session alive.
      this.finishing = true
      this.finished = true
      this.clearTimers()
      this.socket.close()
      return Promise.resolve('')
    }
    if (this.finishPromise) {
      return this.finishPromise
    }

    this.finishing = true
    this.keepaliveTimer = clearTimer(this.keepaliveTimer)
    this.finishPromise = new Promise<string>((resolve, reject) => {
      this.finishResolve = () => resolve('')
      this.finishReject = reject
      this.finishTimeout = setTimeout(() => {
        this.rejectFinish(new Error('Soniox transcription timed out while finishing'))
        this.socket?.close()
      }, SONIOX_FINISH_TIMEOUT_MS)
      this.finishTimeout.unref?.()
    })
    this.sendEndFrameWhenDrained()
    return this.finishPromise
  }

  private handleMessage(data: unknown): void {
    let response: SonioxResponse
    try {
      response = parseSonioxResponse(data)
    } catch (error) {
      this.reportError(error instanceof Error ? error.message : String(error))
      return
    }

    if (typeof response.error_message === 'string') {
      this.reportError(formatSonioxServerError(response, this.apiKey))
      return
    }

    const tokens = Array.isArray(response.tokens) ? (response.tokens as SonioxToken[]) : []
    const finalText = tokens
      .filter(
        (token) =>
          token.is_final === true && typeof token.text === 'string' && !isSonioxControlToken(token)
      )
      .map((token) => token.text)
      .join('')
    const partialText = tokens
      .filter(
        (token) =>
          token.is_final !== true && typeof token.text === 'string' && !isSonioxControlToken(token)
      )
      .map((token) => token.text)
      .join('')
    if (finalText) {
      this.sink({ type: 'final', text: finalText, preserveExactText: true })
    }
    if (tokens.length > 0) {
      this.sink({ type: 'partial', text: partialText })
    }

    if (response.finished === true) {
      this.finished = true
      this.resolveFinish()
    }
  }

  private reportError(message: string): void {
    if (this.reportedError) {
      return
    }
    this.reportedError = true
    this.clearTimers()
    this.sink({ type: 'error', error: message })
    this.resolveFinish()
    this.socket?.close()
  }

  private logConnectionDiagnostic(error: Error): void {
    const detail = sanitizeSonioxConnectionDiagnostic(error, this.apiKey)
    console.warn('[speech] Soniox WebSocket error', { detail })
  }

  private resolveFinish(): void {
    this.finishTimeout = clearTimer(this.finishTimeout)
    this.finishResolve?.()
    this.finishResolve = null
    this.finishReject = null
  }

  private rejectFinish(error: Error): void {
    this.finishTimeout = clearTimer(this.finishTimeout)
    this.finishReject?.(error)
    this.finishResolve = null
    this.finishReject = null
  }

  private pumpAudioQueue(): void {
    if (this.audioPaceTimer || !this.socket) {
      return
    }
    if ((this.socket.bufferedAmount ?? 0) > MAX_SOCKET_BUFFER_BYTES) {
      this.audioPaceTimer = setTimeout(() => {
        this.audioPaceTimer = null
        this.pumpAudioQueue()
      }, 100)
      this.audioPaceTimer.unref?.()
      return
    }
    const next = this.audioQueue.shift()
    if (!next) {
      this.sendEndFrameWhenDrained()
      return
    }
    this.queuedAudioSeconds -= next.durationMs / 1000
    this.socket.send(next.buffer)
    this.scheduleKeepalive()
    // Why: startup buffering can hold many seconds; pace queued PCM near real
    // time so Soniox does not reject a burst as a non-live stream.
    this.audioPaceTimer = setTimeout(() => {
      this.audioPaceTimer = null
      this.pumpAudioQueue()
    }, next.durationMs)
    this.audioPaceTimer.unref?.()
  }

  private sendEndFrameWhenDrained(): void {
    if (!this.finishing || this.endFrameSent || this.audioQueue.length > 0 || this.audioPaceTimer) {
      return
    }
    // Why: Soniox may send final tokens before its finished marker; closing
    // locally here would truncate the transcript. Prefer an empty *text* frame:
    // live Soniox accepts empty text as end-of-stream, but empty binary from
    // the `ws` client is not acknowledged and hangs until request_timeout.
    this.endFrameSent = true
    this.socket?.send('')
  }

  private scheduleKeepalive(): void {
    this.keepaliveTimer = clearTimer(this.keepaliveTimer)
    if (this.finishing || this.finished || this.reportedError) {
      return
    }
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null
      this.socket?.send(JSON.stringify({ type: 'keepalive' }))
      this.scheduleKeepalive()
    }, SONIOX_KEEPALIVE_MS)
    this.keepaliveTimer.unref?.()
  }

  private clearTimers(): void {
    this.startTimeout = clearTimer(this.startTimeout)
    this.keepaliveTimer = clearTimer(this.keepaliveTimer)
    this.audioPaceTimer = clearTimer(this.audioPaceTimer)
    this.finishTimeout = clearTimer(this.finishTimeout)
  }
}
