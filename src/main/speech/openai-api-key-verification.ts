import { saveOpenAiSpeechApiKey } from './openai-api-key-store'
import { OPENAI_TRANSCRIPTION_URL } from './cloud-transcription-target'
import {
  openAiCompatibleTranscriptionUrl,
  resolveOpenAiCompatibleSpeechProviderInput,
  saveOpenAiCompatibleSpeechProvider
} from './openai-compatible-speech-provider-store'
import type { OpenAiCompatibleSpeechProvider } from '../../shared/speech-types'
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
    await rejectUnauthorizedKey(OPENAI_TRANSCRIPTION_URL, trimmed, 'OpenAI')
  }
  saveOpenAiSpeechApiKey(apiKey)
}

/** Same check against the provider's own endpoint, which also catches a wrong base URL. */
export async function saveVerifiedOpenAiCompatibleSpeechProvider(
  input: OpenAiCompatibleSpeechProvider
): Promise<void> {
  const provider = resolveOpenAiCompatibleSpeechProviderInput(input)
  const url = openAiCompatibleTranscriptionUrl(provider.baseUrl)
  await rejectUnauthorizedKey(url, provider.apiKey, new URL(url).host)
  saveOpenAiCompatibleSpeechProvider(provider)
}

async function rejectUnauthorizedKey(url: string, apiKey: string, label: string): Promise<void> {
  let response: Response
  try {
    // An empty form is refused before any transcription, but only after the server checks the key.
    response = await postOpenAiTranscription(
      url,
      apiKey,
      new FormData(),
      AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS)
    )
  } catch {
    return
  }
  if (response.status === 404 || response.status === 405) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error(`${label} has no transcription endpoint at ${url}. Check the base URL.`)
  }
  if (response.status !== 401) {
    void response.body?.cancel().catch(() => undefined)
    return
  }
  const data: OpenAiTranscriptionResponse = await response.json().catch(() => ({}))
  const fallback = apiKey ? `${label} rejected this API key.` : `${label} needs an API key.`
  throw new Error(readOpenAiErrorMessage(data, apiKey) ?? fallback)
}
