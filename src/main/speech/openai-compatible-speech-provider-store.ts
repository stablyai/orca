import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { createEncryptedApiKeyFileStore } from '../credentials/encrypted-api-key-file-store'
import { savedCredentialUnreadable } from '../credentials/saved-credential-readability'
import type {
  OpenAiCompatibleSpeechProvider,
  OpenAiCompatibleSpeechProviderSummary
} from '../../shared/speech/speech-types'
import {
  isSameOpenAiCompatibleEndpoint,
  openAiCompatibleTranscriptionUrl
} from '../../shared/speech/openai-compatible-endpoint'

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

const providerSchema = lazyZodSchema(
  () =>
    z.object({
      baseUrl: z.string().catch(''),
      model: z.string().catch(''),
      apiKey: z.string().catch('')
    }) satisfies z.ZodType<OpenAiCompatibleSpeechProvider>
)

export async function readOpenAiCompatibleSpeechProvider(): Promise<OpenAiCompatibleSpeechProvider | null> {
  // The store caches what it read; another process (desktop vs orca serve) may have removed the file since.
  const raw = (await store.has()) ? await store.read() : null
  if (raw === null) {
    return null
  }
  return providerSchema.parse(JSON.parse(raw))
}

/** Headless hosts may not open a desktop-sealed file; checks the disk quietly, since readiness is polled. */
export async function canReadOpenAiCompatibleSpeechProvider(): Promise<boolean> {
  return (
    (await store.has()) && (await savedCredentialUnreadable(store.envelopeFile())) === undefined
  )
}

export async function summarizeOpenAiCompatibleSpeechProvider(): Promise<OpenAiCompatibleSpeechProviderSummary | null> {
  const provider = await readOpenAiCompatibleSpeechProvider()
  return provider
    ? { baseUrl: provider.baseUrl, model: provider.model, hasApiKey: provider.apiKey !== '' }
    : null
}

/** A blank key keeps the saved one only while the base URL reaches the same endpoint. */
export async function resolveOpenAiCompatibleSpeechProviderInput(
  input: OpenAiCompatibleSpeechProvider
): Promise<OpenAiCompatibleSpeechProvider> {
  const baseUrl = input.baseUrl.trim()
  const model = input.model.trim()
  openAiCompatibleTranscriptionUrl(baseUrl)
  if (!model) {
    throw new Error('Enter the model name the provider expects')
  }
  return { baseUrl, model, apiKey: input.apiKey.trim() || (await savedKeyFor(baseUrl)) }
}

async function savedKeyFor(baseUrl: string): Promise<string> {
  try {
    const saved = await readOpenAiCompatibleSpeechProvider()
    return saved !== null && isSameOpenAiCompatibleEndpoint(saved.baseUrl, baseUrl)
      ? saved.apiKey
      : ''
  } catch {
    // An unreadable saved provider has no key worth keeping.
    return ''
  }
}

export async function saveOpenAiCompatibleSpeechProvider(
  provider: OpenAiCompatibleSpeechProvider
): Promise<void> {
  await store.save(JSON.stringify(provider))
}
