import { saveOpenAiSpeechApiKey } from './openai-api-key-store'
import {
  postOpenAiTranscription,
  readOpenAiErrorMessage,
  type OpenAiTranscriptionResponse
} from './openai-transcription-client'

const KEY_CHECK_TIMEOUT_MS = 10_000

/** Refuses keys OpenAI rejects for transcription; offline or other failures still save, as before. */
export async function saveVerifiedOpenAiSpeechApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim()
  if (trimmed) {
    await rejectUnauthorizedOpenAiKey(trimmed)
  }
  saveOpenAiSpeechApiKey(apiKey)
}

async function rejectUnauthorizedOpenAiKey(apiKey: string): Promise<void> {
  let response: Response
  try {
    // An empty form is refused before any transcription, but only after OpenAI checks the key.
    response = await postOpenAiTranscription(
      apiKey,
      new FormData(),
      AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS)
    )
  } catch {
    return
  }
  if (response.status !== 401) {
    void response.body?.cancel().catch(() => undefined)
    return
  }
  const data: OpenAiTranscriptionResponse = await response.json().catch(() => ({}))
  throw new Error(readOpenAiErrorMessage(data) ?? 'OpenAI rejected this API key.')
}
