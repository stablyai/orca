import { z } from 'zod'
import type { BatchTranscribe } from './batch-cloud-speech-session'
import type { BatchAudioLimit } from './cloud-speech-audio-encoding'
import { assertProviderResponseOk } from './cloud-speech-provider-errors'
import {
  invalidTranscriptionResponse,
  readTranscriptionJson
} from './cloud-speech-transcription-response'
import { SPEECH_TRANSCRIPTION_LANGUAGES } from '../../shared/speech-transcription-languages'

export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com'

// Why: inline audio must stay under the 20 MB request cap; 7 min of 16 kHz WAV is ~18 MB as base64.
export const GEMINI_BATCH_AUDIO_LIMIT: BatchAudioLimit = {
  maxSeconds: 7 * 60,
  message: 'Gemini dictation is limited to 7 minutes per recording.'
}

const TRANSCRIBE_PROMPT =
  'Transcribe this audio verbatim. Reply with only the transcribed text, without commentary, ' +
  'labels or quotes. If there is no speech, reply with an empty string.'

function buildPrompt(language: string | undefined): string {
  const label = SPEECH_TRANSCRIPTION_LANGUAGES.find((entry) => entry.code === language)?.label
  return label
    ? `${TRANSCRIBE_PROMPT} The speaker is most likely speaking ${label}.`
    : TRANSCRIBE_PROMPT
}

const GEMINI_PART = z.object({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  audioTranscription: z.object({ text: z.string().optional() }).optional()
})

const GEMINI_RESPONSE = z.object({
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(GEMINI_PART).optional() }).optional(),
        finishReason: z.string().optional()
      })
    )
    .optional()
})

type GeminiPart = z.infer<typeof GEMINI_PART>
type GeminiResponse = z.infer<typeof GEMINI_RESPONSE>

// Why: Gemini Transcribe models answer in audioTranscription.text; chat models answer in text.
function readPartText(part: GeminiPart): string | undefined {
  return part.text ?? part.audioTranscription?.text
}

function describeReason(reason: string | undefined): string {
  return reason ? ` (${reason})` : ''
}

// Why: a blocked or truncated answer must not read as silence ("No speech detected").
export function readGeminiTranscript(data: GeminiResponse): string {
  if (data.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the request${describeReason(data.promptFeedback.blockReason)}.`)
  }
  const candidate = data.candidates?.[0]
  // Why: thought summaries are model reasoning, not the transcript.
  const parts = candidate?.content?.parts?.filter((part) => part.thought !== true)
  if (!parts || parts.length === 0) {
    // Why: Gemini answers silence with STOP and no parts (verified live).
    if (candidate?.finishReason === 'STOP') {
      return ''
    }
    throw new Error(`Gemini returned no transcript${describeReason(candidate?.finishReason)}.`)
  }
  // Why: MAX_TOKENS, SAFETY or RECITATION cut the answer short; partial text is not the transcript.
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(`Gemini did not complete the transcription (${candidate.finishReason}).`)
  }
  const texts = parts.map(readPartText).filter((text) => text !== undefined)
  // Why: parts without any text field are a shape change, not silence.
  if (texts.length === 0) {
    throw invalidTranscriptionResponse('Gemini')
  }
  const text = texts.join('').trim()
  // Why: the prompt asks for an empty string on silence and the model sometimes quotes it literally.
  return text === '""' ? '' : text
}

/** Gemini has no transcription endpoint; the WAV goes inline into generateContent. */
export function createGeminiTranscribe(apiModel: string): BatchTranscribe {
  return async ({ wav, apiKey, language, signal }) => {
    const body = {
      contents: [
        {
          parts: [
            { text: buildPrompt(language) },
            { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
          ]
        }
      ],
      generationConfig: { temperature: 0 }
    }
    const response = await fetch(
      `${GEMINI_API_BASE_URL}/v1beta/models/${encodeURIComponent(apiModel)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      }
    )
    await assertProviderResponseOk('Gemini', response)
    const data = await readTranscriptionJson('Gemini', response, GEMINI_RESPONSE)
    return readGeminiTranscript(data)
  }
}
