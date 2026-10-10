import type WebSocket from 'ws'
import { z } from 'zod'
import { RealtimeCloudSpeechSession } from './realtime-cloud-speech-session'
import { openProviderWebSocket } from './cloud-speech-websocket'
import type { CloudSpeechSessionOptions } from './cloud-speech-session'
import { CLOUD_TRANSCRIPTION_SAMPLE_RATE } from './cloud-speech-session'

export const SONIOX_REALTIME_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'

/** The stream config frame; also sent by the key probe so it exercises the same permission. */
export function buildSonioxStreamConfig(
  apiModel: string,
  language?: string
): Record<string, unknown> {
  return {
    model: apiModel,
    audio_format: 'pcm_s16le',
    sample_rate: CLOUD_TRANSCRIPTION_SAMPLE_RATE,
    num_channels: 1,
    ...(language ? { language_hints: [language] } : {})
  }
}

const TokenFrameSchema = z.object({
  tokens: z.array(z.looseObject({ text: z.string(), is_final: z.boolean() })).optional(),
  finished: z.boolean().optional()
})

type SonioxToken = { text: string; is_final: boolean }

/** Soniox streams tokens: final ones are sent once, non-final ones are re-sent each message. */
export class SonioxRealtimeSession extends RealtimeCloudSpeechSession {
  private finalText = ''
  private pendingText = ''

  constructor(
    private readonly apiModel: string,
    options: CloudSpeechSessionOptions
  ) {
    super('Soniox', options)
  }

  protected createSocket(apiKey: string): WebSocket {
    // Why: Soniox is retiring api_key in the config frame; the handshake header replaces it.
    return openProviderWebSocket(SONIOX_REALTIME_URL, { Authorization: `Bearer ${apiKey}` })
  }

  protected onOpen(): void {
    this.sendJson(buildSonioxStreamConfig(this.apiModel, this.language))
    this.markAccepting()
  }

  protected handleMessage(message: Record<string, unknown>): void {
    if (message.error_code !== undefined || typeof message.error_message === 'string') {
      const detail = typeof message.error_message === 'string' ? message.error_message : ''
      this.fail(`Soniox error ${String(message.error_code ?? '')}: ${detail}`.trim())
      return
    }
    // Why: a malformed token would otherwise be skipped and clear the in-progress text.
    const frame = TokenFrameSchema.safeParse(message)
    if (!frame.success) {
      this.fail(`${this.label} returned an invalid realtime response.`)
      return
    }
    if (frame.data.tokens) {
      this.acceptTokens(frame.data.tokens)
    }
    if (frame.data.finished === true) {
      this.markFinished()
    }
  }

  protected sendAudio(pcm: Buffer): void {
    this.socket?.send(pcm)
  }

  protected sendEnd(): void {
    // Why: an empty text frame ends the audio; Soniox finalizes every token, then sends finished.
    // An empty binary frame is ignored (verified against the live API).
    this.socket?.send('')
  }

  protected runningTranscript(): string {
    return this.finalText + this.pendingText
  }

  protected finalTranscript(): string {
    return this.finalText + this.pendingText
  }

  private acceptTokens(tokens: SonioxToken[]): void {
    let pending = ''
    for (const { text, is_final: isFinal } of tokens) {
      // Why: control tokens such as <fin> and <end> are markers, not speech.
      if (/^<\w+>$/.test(text)) {
        continue
      }
      if (isFinal) {
        this.finalText += text
      } else {
        pending += text
      }
    }
    this.pendingText = pending
    this.publishPartial()
  }
}
