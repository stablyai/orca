import WebSocket from 'ws'
import { resampleToRate } from './stt-audio-resample'
import type { SttEventSink } from './stt-service'

export class ElevenLabsTranscriptionSession {
  private socket: WebSocket | null = null
  private ready = false
  private closed = false
  private finishing = false
  private dirty = false
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private finishResolve: (() => void) | null = null
  private finishReject: ((error: Error) => void) | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly sink: SttEventSink) {}

  start(apiKey: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime')
      url.searchParams.set('model_id', 'scribe_v2_realtime')
      url.searchParams.set('audio_format', 'pcm_16000')
      url.searchParams.set('keepalive_interval_ms', '5000')
      url.searchParams.set('commit_strategy', 'vad')
      url.searchParams.set('vad_silence_threshold_secs', '1.2')
      this.startTimer = setTimeout(() => this.fail('elevenlabs_connection_timeout'), 15_000)
      try {
        this.socket = new WebSocket(url, {
          headers: { 'xi-api-key': apiKey },
          handshakeTimeout: 15_000,
          maxPayload: 1024 * 1024,
          followRedirects: false
        })
        this.socket.on('message', (data) => this.receive(data.toString()))
        this.socket.on('error', () => this.fail('elevenlabs_connection_failed'))
        this.socket.on('close', () => this.fail('elevenlabs_connection_closed'))
      } catch {
        this.fail('elevenlabs_connection_failed')
      }
    })
  }

  private receive(raw: string): void {
    if (this.closed) {
      return
    }
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      this.fail('elevenlabs_invalid_response')
      return
    }
    if (!data || typeof data !== 'object' || !('message_type' in data)) {
      return
    }
    const kind = data.message_type
    if (kind === 'session_started' && !this.ready) {
      this.ready = true
      if (this.startTimer) {
        clearTimeout(this.startTimer)
      }
      this.readyResolve?.()
      this.readyResolve = null
      this.readyReject = null
      this.resetIdleTimer()
    } else if (kind === 'partial_transcript' || kind === 'committed_transcript') {
      if (!this.ready || !('text' in data) || typeof data.text !== 'string') {
        return
      }
      this.resetIdleTimer()
      if (kind === 'committed_transcript') {
        this.dirty = false
        if (data.text.trim()) {
          this.sink({ type: 'final', text: `${data.text.trim()} ` })
        }
        this.finishResolve?.()
      } else {
        this.sink({ type: 'partial', text: data.text })
      }
    } else if (kind !== 'warning' && kind !== 'session_started') {
      // Never forward vendor error bodies, which can contain credentials or input.
      const code =
        typeof kind === 'string' &&
        /^(auth_error|quota_exceeded|rate_limited|unaccepted_terms)$/.test(kind)
          ? kind
          : 'transcription_failed'
      this.fail(`elevenlabs_${code}`)
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
    }
    this.idleTimer = setTimeout(() => this.fail('elevenlabs_connection_timeout'), 30_000)
  }

  feedAudio(samples: Float32Array, sampleRate: number): void {
    if (this.closed || this.finishing || !this.ready) {
      return
    }
    if (
      !Number.isFinite(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 192000 ||
      samples.length > sampleRate * 2
    ) {
      this.fail('elevenlabs_invalid_audio')
      return
    }
    const normalized = resampleToRate(samples, sampleRate, 16000)
    if (!normalized.length) {
      return
    }
    const pcm = Buffer.alloc(normalized.length * 2)
    for (let i = 0; i < normalized.length; i++) {
      const value = Number.isFinite(normalized[i]) ? Math.max(-1, Math.min(1, normalized[i])) : 0
      pcm.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * 2)
    }
    this.dirty = true
    this.send(pcm, false)
  }

  private send(pcm: Buffer, commit: boolean): void {
    if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 512 * 1024) {
      this.fail('elevenlabs_audio_backpressure')
      return
    }
    this.socket.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: pcm.toString('base64'),
        sample_rate: 16000,
        commit
      }),
      (error) => {
        if (error) {
          this.fail('elevenlabs_connection_failed')
        }
      }
    )
  }

  async finish(): Promise<string> {
    if (this.closed) {
      return ''
    }
    this.finishing = true
    if (!this.ready || !this.dirty) {
      this.dispose()
      return ''
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        this.finishResolve = resolve
        this.finishReject = reject
        timer = setTimeout(() => reject(new Error('elevenlabs_commit_timeout')), 8_000)
        this.send(Buffer.alloc(16000), true)
      })
      return ''
    } finally {
      clearTimeout(timer)
      this.dispose()
    }
  }

  private fail(code: string): void {
    if (this.closed) {
      return
    }
    const error = new Error(code)
    const notify = this.ready && !this.finishing
    this.readyReject?.(error)
    this.finishReject?.(error)
    this.dispose()
    if (notify) {
      this.sink({ type: 'error', error: code })
    }
  }

  private dispose(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    if (this.startTimer) {
      clearTimeout(this.startTimer)
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
    }
    this.readyReject?.(new Error('dictation_canceled'))
    this.readyReject = null
    this.readyResolve = null
    this.finishResolve = null
    this.finishReject = null
    this.socket?.terminate()
    this.socket = null
  }
}
