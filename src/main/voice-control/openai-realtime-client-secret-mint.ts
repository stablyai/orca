import type { MainHttpClient } from '../network/http-client'
import type { OpenAiRealtimeVoice } from '../../shared/voice-control-types'
import { VoiceControlRealtimeError } from './voice-control-realtime-error'
import type { RealtimeToolSchema } from './voice-control-tool-schemas'

/**
 * Mints the scoped, short-lived credential one control session's renderer connects with.
 * Wire shape mirrors the field-for-field spiked one from otto#4297, not OpenAI's
 * (inconsistent) docs. The caller owns instructions/tools/voice; the model, transcription,
 * and noise reduction are fixed here.
 */

export const REALTIME_MODEL = 'gpt-realtime-2.1'
// Why a separate pass: without audio.input.transcription the provider never transcribes
// the user's own speech at all (live-confirmed in otto#4297).
const INPUT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe'
// Why pinned: the Whisper family free-runs its language guess on noise/mumbles and
// hallucinates foreign phrases (live: Turkish and Arabic "You:" lines from an English
// session). The coordinator's instructions are English-only, so the session language is
// English — say so, and the guesses stop.
const INPUT_TRANSCRIPTION_LANGUAGE = 'en'
const CREDENTIAL_TTL_SECONDS = 600

export type RealtimeSessionDeclaration = {
  instructions: string
  tools: RealtimeToolSchema[]
  voice: OpenAiRealtimeVoice
}

export type MintedRealtimeClientSecret = {
  value: string
  expiresAt: number | null
}

export async function mintRealtimeClientSecret(
  http: Pick<MainHttpClient, 'fetch'>,
  apiKey: string,
  declaration: RealtimeSessionDeclaration
): Promise<MintedRealtimeClientSecret> {
  let response: Response
  try {
    response = await http.fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: CREDENTIAL_TTL_SECONDS },
        session: {
          type: 'realtime',
          model: REALTIME_MODEL,
          instructions: declaration.instructions,
          output_modalities: ['audio'],
          audio: {
            input: {
              transcription: {
                model: INPUT_TRANSCRIPTION_MODEL,
                language: INPUT_TRANSCRIPTION_LANGUAGE
              },
              noise_reduction: { type: 'far_field' }
            },
            output: { voice: declaration.voice }
          },
          tools: declaration.tools
        }
      })
    })
  } catch (error) {
    throw VoiceControlRealtimeError.fromFetchFailure(error)
  }
  if (response.status >= 400) {
    throw await VoiceControlRealtimeError.fromHttpResponse(response)
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch (error) {
    throw new VoiceControlRealtimeError('unknown', 'malformed client_secrets response', {
      cause: error
    })
  }
  const value =
    typeof parsed === 'object' && parsed !== null && 'value' in parsed ? parsed.value : undefined
  if (typeof value !== 'string' || value.length === 0) {
    // Why a hard failure: this credential is the entire point of the call, so a degraded
    // 2xx body is not tolerated (same posture as otto-voice).
    throw new VoiceControlRealtimeError('unknown', 'client_secrets response missing value')
  }
  const expiresAt =
    typeof parsed === 'object' && parsed !== null && 'expires_at' in parsed
      ? parsed.expires_at
      : undefined
  return { value, expiresAt: typeof expiresAt === 'number' ? expiresAt : null }
}
