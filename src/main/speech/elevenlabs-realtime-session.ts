import type WebSocket from 'ws'
import { z } from 'zod'
import { RealtimeCloudSpeechSession } from './realtime-cloud-speech-session'
import { openProviderWebSocket } from './cloud-speech-websocket'
import {
  CLOUD_TRANSCRIPTION_SAMPLE_RATE,
  type CloudSpeechSessionOptions
} from './cloud-speech-session'

export const ELEVENLABS_REALTIME_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'

const ERROR_MESSAGE_TYPES = new Set([
  'error',
  'auth_error',
  'quota_exceeded',
  'rate_limited',
  'resource_exhausted',
  'session_time_limit_exceeded',
  'input_error',
  'chunk_size_exceeded',
  'transcriber_error',
  'commit_throttled',
  'unaccepted_terms',
  'invalid_request',
  'queue_overflow',
  'insufficient_audio_activity'
])

const TranscriptFrameSchema = z.object({ text: z.string() })

/** ElevenLabs Scribe realtime with manual commit: partials replace, commits append. */
export class ElevenLabsRealtimeSession extends RealtimeCloudSpeechSession {
  private readonly committed: string[] = []
  private partialText = ''

  constructor(
    private readonly apiModel: string,
    options: CloudSpeechSessionOptions
  ) {
    super('ElevenLabs', options)
  }

  protected createSocket(apiKey: string): WebSocket {
    const url = new URL(ELEVENLABS_REALTIME_URL)
    url.searchParams.set('model_id', this.apiModel)
    url.searchParams.set('audio_format', `pcm_${CLOUD_TRANSCRIPTION_SAMPLE_RATE}`)
    url.searchParams.set('commit_strategy', 'manual')
    if (this.language) {
      url.searchParams.set('language_code', this.language)
    }
    return openProviderWebSocket(url, { 'xi-api-key': apiKey })
  }

  protected onOpen(): void {
    // Audio waits for session_started.
  }

  protected handleMessage(message: Record<string, unknown>): void {
    const type = message.message_type
    if (type === 'session_started') {
      this.markAccepting()
      return
    }
    if (typeof type === 'string' && ERROR_MESSAGE_TYPES.has(type)) {
      const detail = typeof message.error === 'string' ? message.error : message.message
      this.fail(
        `ElevenLabs ${type.replace(/_/g, ' ')}: ${typeof detail === 'string' ? detail : ''}`
      )
      return
    }
    const isPartial = type === 'partial_transcript'
    const isCommitted =
      type === 'committed_transcript' || type === 'committed_transcript_with_timestamps'
    if (!isPartial && !isCommitted) {
      return
    }
    // Why: a malformed commit would otherwise count as a flush and drop the in-progress text.
    const frame = TranscriptFrameSchema.safeParse(message)
    if (!frame.success) {
      this.fail(`${this.label} returned an invalid realtime response.`)
      return
    }
    const text = frame.data.text.trim()
    if (isPartial) {
      this.partialText = text
      this.publishPartial()
      return
    }
    if (type === 'committed_transcript_with_timestamps' && this.committedTextSeen(text)) {
      return
    }
    if (text) {
      this.committed.push(text)
    }
    this.partialText = ''
    this.publishPartial()
    this.markFinished()
  }

  protected sendAudio(pcm: Buffer): void {
    this.sendJson({
      message_type: 'input_audio_chunk',
      audio_base_64: pcm.toString('base64'),
      commit: false,
      sample_rate: CLOUD_TRANSCRIPTION_SAMPLE_RATE
    })
  }

  protected sendEnd(): void {
    this.sendJson({
      message_type: 'input_audio_chunk',
      audio_base_64: '',
      commit: true,
      sample_rate: CLOUD_TRANSCRIPTION_SAMPLE_RATE
    })
  }

  protected runningTranscript(): string {
    return [...this.committed, this.partialText].filter(Boolean).join(' ')
  }

  protected finalTranscript(): string {
    return this.runningTranscript()
  }

  private committedTextSeen(text: string): boolean {
    return this.committed.at(-1) === text
  }
}
