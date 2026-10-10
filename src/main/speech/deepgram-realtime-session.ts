import type WebSocket from 'ws'
import { z } from 'zod'
import { RealtimeCloudSpeechSession } from './realtime-cloud-speech-session'
import { openProviderWebSocket } from './cloud-speech-websocket'
import {
  CLOUD_TRANSCRIPTION_SAMPLE_RATE,
  type CloudSpeechSessionOptions
} from './cloud-speech-session'

export const DEEPGRAM_REALTIME_URL = 'wss://api.deepgram.com/v1/listen'
const KEEPALIVE_INTERVAL_MS = 5_000

const ResultsFrameSchema = z.object({
  is_final: z.boolean(),
  channel: z.object({
    alternatives: z.array(z.object({ transcript: z.string() })).min(1)
  })
})

// Why: live errors arrive as {type:'Error', description, code}; older ones as err_msg/error.
export function readDeepgramError(message: Record<string, unknown>): string | null {
  const { err_msg: errMsg, error, type, description, message: text, code } = message
  if (typeof errMsg === 'string' || typeof error === 'string') {
    return String(errMsg ?? error)
  }
  if (type !== 'Error') {
    return null
  }
  const detail = [description, text].find((value) => typeof value === 'string' && value)
  const codeLabel = typeof code === 'string' && code ? ` (${code})` : ''
  return `${typeof detail === 'string' ? detail : 'stream failed'}${codeLabel}`
}

/** Deepgram live: interim results replace, is_final results append; CloseStream flushes. */
export class DeepgramRealtimeSession extends RealtimeCloudSpeechSession {
  private readonly committed: string[] = []
  private interimText = ''
  private keepAlive: NodeJS.Timeout | null = null

  constructor(
    private readonly apiModel: string,
    options: CloudSpeechSessionOptions
  ) {
    super('Deepgram', options)
  }

  protected createSocket(apiKey: string): WebSocket {
    const url = new URL(DEEPGRAM_REALTIME_URL)
    url.searchParams.set('model', this.apiModel)
    url.searchParams.set('encoding', 'linear16')
    url.searchParams.set('sample_rate', String(CLOUD_TRANSCRIPTION_SAMPLE_RATE))
    url.searchParams.set('channels', '1')
    url.searchParams.set('smart_format', 'true')
    url.searchParams.set('punctuate', 'true')
    url.searchParams.set('interim_results', 'true')
    // Why: without a hint Deepgram assumes English; 'multi' enables Nova-3 code-switching.
    url.searchParams.set('language', this.language ?? 'multi')
    return openProviderWebSocket(url, { Authorization: `Token ${apiKey}` })
  }

  protected onOpen(): void {
    this.keepAlive = setInterval(() => this.sendJson({ type: 'KeepAlive' }), KEEPALIVE_INTERVAL_MS)
    this.keepAlive.unref?.()
    this.markAccepting()
  }

  protected handleMessage(message: Record<string, unknown>): void {
    const error = readDeepgramError(message)
    if (error !== null) {
      this.fail(`Deepgram error: ${error}`)
      return
    }
    if (message.type !== 'Results') {
      return
    }
    // Why: a malformed Results frame would otherwise clear the interim text.
    const frame = ResultsFrameSchema.safeParse(message)
    if (!frame.success) {
      this.fail(`${this.label} returned an invalid realtime response.`)
      return
    }
    const text = frame.data.channel.alternatives[0].transcript.trim()
    if (frame.data.is_final) {
      if (text) {
        this.committed.push(text)
      }
      this.interimText = ''
    } else {
      this.interimText = text
    }
    this.publishPartial()
  }

  protected sendAudio(pcm: Buffer): void {
    this.socket?.send(pcm)
  }

  protected sendEnd(): void {
    this.stopKeepAlive()
    // Why: CloseStream makes Deepgram flush pending results, then close; close settles finish.
    this.sendJson({ type: 'CloseStream' })
  }

  protected runningTranscript(): string {
    return [...this.committed, this.interimText].filter(Boolean).join(' ')
  }

  protected finalTranscript(): string {
    return this.runningTranscript()
  }

  protected onClosed(): void {
    this.stopKeepAlive()
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive)
      this.keepAlive = null
    }
  }
}
