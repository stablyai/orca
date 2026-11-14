import { z } from 'zod'
import { createEncryptedApiKeyFileStore } from '../credentials/encrypted-api-key-file-store'
import { savedCredentialUnreadable } from '../credentials/saved-credential-readability'
import type {
  OpenAiCompatibleSpeechProvider,
  OpenAiCompatibleSpeechProviderSummary
} from '../../shared/speech-types'

// URL, model and key are sealed together so a key can never be sent to a host it wasn't saved for.
const store = createEncryptedApiKeyFileStore({
  fileName: 'openai-compatible-speech-provider.enc',
  envelopePrefix: 'orca-openai-compatible-speech:v1:',
  providerLabel: 'OpenAI-compatible speech provider',
  logScope: 'speech'
})

export const hasOpenAiCompatibleSpeechProvider = store.has
export const clearOpenAiCompatibleSpeechProvider = store.clear
export const openAiCompatibleSpeechProviderEnvelopeFile = store.envelopeFile

const TRANSCRIPTION_PATH = '/audio/transcriptions'

const providerSchema = z.object({
  baseUrl: z.string().catch(''),
  model: z.string().catch(''),
  apiKey: z.string().catch('')
}) satisfies z.ZodType<OpenAiCompatibleSpeechProvider>

/** Accepts a base like `https://api.groq.com/openai/v1` or the full transcriptions URL. */
export function openAiCompatibleTranscriptionUrl(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new Error('Enter a full base URL, such as https://api.groq.com/openai/v1')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The base URL must start with https:// or http://')
  }
  // fetch refuses these, and its error would echo the password.
  if (url.username || url.password) {
    throw new Error('Put the key in the API Key field, not in the base URL')
  }
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith(TRANSCRIPTION_PATH) ? path : `${path}${TRANSCRIPTION_PATH}`
  return url.toString()
}

export function readOpenAiCompatibleSpeechProvider(): OpenAiCompatibleSpeechProvider | null {
  // The store caches what it read; another process (desktop vs orca serve) may have removed the file since.
  const raw = store.has() ? store.read() : null
  if (raw === null) {
    return null
  }
  return providerSchema.parse(JSON.parse(raw))
}

/** Headless hosts may not open a desktop-sealed file; checks the disk quietly, since readiness is polled. */
export function canReadOpenAiCompatibleSpeechProvider(): boolean {
  return store.has() && savedCredentialUnreadable(store.envelopeFile()) === undefined
}

export function summarizeOpenAiCompatibleSpeechProvider(): OpenAiCompatibleSpeechProviderSummary | null {
  const provider = readOpenAiCompatibleSpeechProvider()
  return provider
    ? { baseUrl: provider.baseUrl, model: provider.model, hasApiKey: provider.apiKey !== '' }
    : null
}

/** A blank key keeps the saved one only while the base URL is unchanged. */
export function resolveOpenAiCompatibleSpeechProviderInput(
  input: OpenAiCompatibleSpeechProvider
): OpenAiCompatibleSpeechProvider {
  const baseUrl = input.baseUrl.trim()
  const model = input.model.trim()
  openAiCompatibleTranscriptionUrl(baseUrl)
  if (!model) {
    throw new Error('Enter the model name the provider expects')
  }
  return { baseUrl, model, apiKey: input.apiKey.trim() || savedKeyFor(baseUrl) }
}

function savedKeyFor(baseUrl: string): string {
  try {
    const saved = readOpenAiCompatibleSpeechProvider()
    const sameEndpoint =
      saved !== null &&
      openAiCompatibleTranscriptionUrl(saved.baseUrl) === openAiCompatibleTranscriptionUrl(baseUrl)
    return sameEndpoint ? saved.apiKey : ''
  } catch {
    // An unreadable or invalid saved provider has no key worth keeping.
    return ''
  }
}

export function saveOpenAiCompatibleSpeechProvider(provider: OpenAiCompatibleSpeechProvider): void {
  store.save(JSON.stringify(provider))
}
