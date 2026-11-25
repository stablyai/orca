import type { ClientRequest, IncomingMessage } from 'node:http'
import WebSocket from 'ws'
import {
  CLOUD_TRANSCRIPTION_SAMPLE_RATE,
  UPLOAD_BYTES_PER_MS,
  MAX_CLOUD_TRANSCRIPTION_SECONDS
} from '../../shared/speech/dictation/dictation-finish-deadlines'
import type { CloudDictationSession } from './cloud-dictation-session'
import { sanitizeOpenAiTranscriptionErrorMessage } from './openai-transcription-client'
import { resampleToRate } from './stt-audio-resample'
import type { SttEventSink } from './stt-service'
import {
  encodePcm16,
  openSonioxSocket,
  parseSonioxFrame,
  readSonioxError,
  SONIOX_REALTIME_URL,
  sonioxStreamConfig,
  SONIOX_REFUSED_KEY_STATUSES,
  sonioxKeyRefusalMessage,
  sonioxTokenFrameSchema,
  type OpenSonioxSocket,
  type SonioxSocket
} from './soniox-protocol'

const MAX_AUDIO_SAMPLES = MAX_CLOUD_TRANSCRIPTION_SECONDS * CLOUD_TRANSCRIPTION_SAMPLE_RATE
// A socket that never opens would otherwise hold the whole dictation in the queue.
export const SONIOX_ACCEPT_TIMEOUT_MS = 15_000
// Soniox answers `finished` within a second of the end frame; this bounds a stalled stream.
export const SONIOX_FINISH_TIMEOUT_MS = 10_000
// A stalled socket would otherwise buffer the whole dictation in memory.
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024

export type SonioxRealtimeSessionOptions = {
  readApiKey: () => Promise<string>
  language: string | undefined
  /** Spellings the dictation's dictionary expects; Soniox biases toward them. */
  terms: readonly string[]
  sink: SttEventSink
  /** A failure before stop: the dictation can't go on, so the caller ends it. */
  onFailure: (error: string) => void
  /** True once the dictation was stopped while its key was being read; no stream opens then. */
  isCanceled: () => boolean
  openSocket?: OpenSonioxSocket
}

/**
 * Streams one dictation to Soniox. Finalized tokens are held until Soniox marks a pause (<end>), then sent as one
 * 'final', so text lands per phrase; the words since, finalized or not, go out as 'partial'.
 */
export class SonioxRealtimeSession implements CloudDictationSession {
  private socket: SonioxSocket | null = null
  private apiKey = ''
  private accepting = false
  private closed = false
  private failure: string | null = null
  private endSent = false
  private finished = false
  private canceled = false
  private readonly queued: Buffer[] = []
  private audioSamples = 0
  /** Finalized since the last 'final'. */
  private finalized = ''
  /** Not finalized yet; Soniox resends the whole tail with every frame. */
  private tentative = ''
  private lastPartial = ''
  private settleFinish: (() => void) | null = null
  private acceptTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: SonioxRealtimeSessionOptions) {}

  /** Opens the stream; throws when the key can't be read, so the dictation fails to start instead. */
  async start(): Promise<void> {
    this.apiKey = await this.options.readApiKey()
    if (this.options.isCanceled()) {
      return
    }
    const socket = (this.options.openSocket ?? openSonioxSocket)(SONIOX_REALTIME_URL, this.apiKey)
    this.socket = socket
    socket.on('open', () => {
      socket.send(JSON.stringify(sonioxStreamConfig(this.options.language, this.options.terms)))
      this.accept()
    })
    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        this.handleFrame(data.toString())
      }
    })
    socket.on('unexpected-response', (request: ClientRequest, response: IncomingMessage) => {
      const status = response.statusCode ?? 0
      request.destroy()
      this.fail(
        SONIOX_REFUSED_KEY_STATUSES.has(status)
          ? sonioxKeyRefusalMessage(status)
          : `Soniox refused the connection (${status}).`
      )
    })
    socket.on('error', (error: Error) => this.fail(`Could not reach Soniox: ${error.message}`))
    socket.on('close', (code: number, reason: Buffer) => {
      // Any close before the end frame (even 1000, at a session limit) drops the audio after it.
      // After the end frame, only a close that follows `finished` means every word arrived.
      if (this.finished) {
        this.settleFinish?.()
        return
      }
      const detail = reason.toString()
      this.fail(`Soniox closed the stream (${code}${detail ? `: ${detail}` : ''}).`)
    })
    this.acceptTimer = setTimeout(
      () => this.fail('Soniox did not start the stream in time.'),
      SONIOX_ACCEPT_TIMEOUT_MS
    )
    this.acceptTimer.unref?.()
  }

  feedAudio(samples: Float32Array, sampleRate: number): boolean {
    const room = MAX_AUDIO_SAMPLES - this.audioSamples
    if (this.closed || this.failure || this.endSent || room <= 0) {
      return false
    }
    const kept = resampleToRate(samples, sampleRate, CLOUD_TRANSCRIPTION_SAMPLE_RATE).slice(0, room)
    if (kept.length === 0) {
      return false
    }
    this.audioSamples += kept.length
    const pcm = encodePcm16(kept)
    if (!this.accepting) {
      this.queued.push(pcm)
    } else if (this.socket && this.socket.bufferedAmount + pcm.length > MAX_BUFFERED_BYTES) {
      this.fail('Soniox connection is too slow.')
    } else {
      this.socket?.send(pcm)
    }
    return this.audioSamples === MAX_AUDIO_SAMPLES
  }

  async finish(): Promise<string> {
    if (!this.closed && !this.failure && this.audioSamples > 0) {
      // Audio still waiting to go out gets the time cloud uploads allow for it.
      const unsentBytes =
        (this.socket?.bufferedAmount ?? 0) + this.queued.reduce((sum, pcm) => sum + pcm.length, 0)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            this.failure ??= this.accepting
              ? 'Soniox did not finish the transcript in time; the end may be missing.'
              : 'Soniox did not start the stream in time.'
            done()
          },
          SONIOX_FINISH_TIMEOUT_MS + Math.ceil(unsentBytes / UPLOAD_BYTES_PER_MS)
        )
        function done(): void {
          clearTimeout(timer)
          resolve()
        }
        this.settleFinish = done
        if (this.accepting) {
          this.sendEnd()
        }
      })
    }
    const failure = this.failure
    // A failed finish still lands the words Soniox finalized; tentative ones may be wrong.
    const rest = failure ? this.finalized : this.finalized + this.tentative
    this.finalized = ''
    this.tentative = ''
    this.close()
    if (this.canceled) {
      return ''
    }
    if (failure) {
      if (rest.trim()) {
        this.options.sink({ type: 'final', text: rest.trim() })
      }
      throw new Error(failure)
    }
    return rest.trim()
  }

  cancel(): void {
    this.canceled = true
    this.close()
  }

  private accept(): void {
    if (this.accepting || this.closed) {
      return
    }
    this.accepting = true
    this.clearAcceptTimer()
    for (const pcm of this.queued.splice(0)) {
      this.socket?.send(pcm)
    }
    // Stop came while the stream was opening.
    if (this.settleFinish) {
      this.sendEnd()
    }
  }

  private sendEnd(): void {
    if (this.endSent) {
      return
    }
    this.endSent = true
    // An empty text frame ends the audio; Soniox finalizes every token, then sends `finished`.
    this.socket?.send('')
  }

  private handleFrame(raw: string): void {
    const frame = parseSonioxFrame(raw)
    if (!frame) {
      return
    }
    const error = readSonioxError(frame)
    if (error) {
      this.fail(error)
      return
    }
    const parsed = sonioxTokenFrameSchema.safeParse(frame)
    if (!parsed.success) {
      this.fail('Soniox sent a transcript frame Orca could not read.')
      return
    }
    let tentative = ''
    for (const token of parsed.data.tokens ?? []) {
      if (token.text === '<end>') {
        // After the end frame finish() returns the rest in one piece.
        if (!this.endSent) {
          this.commit()
        }
      } else if (/^<\w+>$/.test(token.text)) {
        // Other control tokens such as <fin> are markers, not speech.
        continue
      } else if (token.is_final) {
        this.finalized += token.text
      } else {
        tentative += token.text
      }
    }
    this.tentative = tentative
    this.publishPartial()
    if (parsed.data.finished === true) {
      this.finished = true
      this.settleFinish?.()
    }
  }

  private commit(): void {
    const text = this.finalized.trim()
    this.finalized = ''
    if (text) {
      this.lastPartial = ''
      this.options.sink({ type: 'final', text })
    }
  }

  private publishPartial(): void {
    // After the end frame finish() returns the rest, so the pill keeps its last live text until then.
    if (this.closed || this.endSent) {
      return
    }
    const text = (this.finalized + this.tentative).trim()
    if (text !== this.lastPartial) {
      this.lastPartial = text
      this.options.sink({ type: 'partial', text })
    }
  }

  private fail(message: string): void {
    if (this.failure || this.closed) {
      return
    }
    // Soniox can echo the key, so the exact key sent is redacted along with the usual shapes.
    this.failure = sanitizeOpenAiTranscriptionErrorMessage(message, this.apiKey)
    if (this.settleFinish) {
      // finish() is waiting and reports the failure itself.
      this.settleFinish()
      return
    }
    const failure = this.failure
    // Words Soniox already finalized land before the dictation ends.
    this.commit()
    this.close()
    this.options.onFailure(failure)
  }

  private clearAcceptTimer(): void {
    if (this.acceptTimer) {
      clearTimeout(this.acceptTimer)
      this.acceptTimer = null
    }
  }

  private close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.queued.length = 0
    this.clearAcceptTimer()
    // cancel() during finish() must not leave finish waiting for its timeout.
    this.settleFinish?.()
    const socket = this.socket
    this.socket = null
    if (!socket) {
      return
    }
    socket.removeAllListeners()
    // A late socket error after removeAllListeners would otherwise crash the main process.
    socket.on('error', () => undefined)
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1000)
    } else {
      socket.terminate()
    }
  }
}
