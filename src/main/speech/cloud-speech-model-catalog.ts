import type { SpeechModelManifest } from '../../shared/speech-types'
import { VOXTRAL_TRANSCRIPTION_LANGUAGES } from '../../shared/speech-transcription-languages'

type CloudSpeechCatalogEntry = {
  manifest: SpeechModelManifest
  /** Model name the provider API expects; main-only so the shared manifest stays provider-neutral. */
  apiModel: string
}

function cloudEntry(
  entry: Omit<SpeechModelManifest, 'type' | 'language' | 'sampleRate' | 'streaming'> & {
    apiModel: string
  }
): CloudSpeechCatalogEntry {
  const { apiModel, ...manifest } = entry
  return {
    apiModel,
    manifest: {
      ...manifest,
      type: 'cloud',
      language: 'multilingual',
      sampleRate: 16000,
      streaming: false,
      realtime: manifest.realtime === true,
      transcriptionLanguages: manifest.transcriptionLanguages ?? 'any'
    }
  }
}

// Why: OpenAI rows keep type 'openai' because shipped desktop and mobile builds pin that shape.
const OPENAI_ENTRIES: CloudSpeechCatalogEntry[] = [
  {
    apiModel: 'gpt-transcribe',
    manifest: {
      id: 'openai-gpt-transcribe',
      label: 'GPT Transcribe',
      description:
        "OpenAI's newest transcription model: more accurate and cheaper than GPT-4o Transcribe.",
      type: 'openai',
      provider: 'openai',
      language: 'multilingual',
      sampleRate: 16000,
      streaming: false,
      transcriptionLanguages: 'any'
    }
  },
  {
    apiModel: 'gpt-4o-mini-transcribe',
    manifest: {
      id: 'openai-gpt-4o-mini-transcribe',
      label: 'GPT-4o mini Transcribe',
      description:
        'Cloud transcription with strong accuracy and low cost. Requires an OpenAI API key.',
      type: 'openai',
      provider: 'openai',
      language: 'multilingual',
      sampleRate: 16000,
      streaming: false,
      transcriptionLanguages: 'any'
    }
  },
  {
    apiModel: 'gpt-4o-transcribe',
    manifest: {
      id: 'openai-gpt-4o-transcribe',
      label: 'GPT-4o Transcribe',
      description: 'Cloud transcription with higher accuracy. Requires an OpenAI API key.',
      type: 'openai',
      provider: 'openai',
      language: 'multilingual',
      sampleRate: 16000,
      streaming: false,
      transcriptionLanguages: 'any'
    }
  }
]

export const SONIOX_REALTIME_API_MODEL = 'stt-rt-v5'

const CLOUD_ENTRIES: CloudSpeechCatalogEntry[] = [
  ...OPENAI_ENTRIES,
  cloudEntry({
    id: 'soniox-stt-rt-v5',
    label: 'Soniox Real-time v5',
    description: 'Live captions while you speak, 60+ languages. Requires a Soniox API key.',
    provider: 'soniox',
    apiModel: SONIOX_REALTIME_API_MODEL,
    realtime: true
  }),
  cloudEntry({
    id: 'elevenlabs-scribe-v2-realtime',
    label: 'Scribe v2 Real-time',
    description: 'ElevenLabs streaming transcription with live captions in 90+ languages.',
    provider: 'elevenlabs',
    apiModel: 'scribe_v2_realtime',
    realtime: true
  }),
  cloudEntry({
    id: 'elevenlabs-scribe-v2',
    label: 'Scribe v2',
    description: 'ElevenLabs high-accuracy transcription of the whole recording.',
    provider: 'elevenlabs',
    apiModel: 'scribe_v2'
  }),
  cloudEntry({
    id: 'deepgram-nova-3',
    label: 'Nova-3',
    description: 'Deepgram low-latency streaming with live captions.',
    provider: 'deepgram',
    apiModel: 'nova-3',
    realtime: true
  }),
  cloudEntry({
    id: 'gemini-3.5-transcribe',
    label: 'Gemini 3.5 Transcribe',
    description: "Google's dedicated speech-to-text model, 85+ languages.",
    provider: 'gemini',
    apiModel: 'gemini-3.5-transcribe'
  }),
  cloudEntry({
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    description: 'Newest Gemini Flash model; transcribes the whole recording at once.',
    provider: 'gemini',
    apiModel: 'gemini-3.8-flash'
  }),
  cloudEntry({
    id: 'gemini-flash-latest',
    label: 'Gemini Flash (latest)',
    description: "Google's newest Flash model transcribes the whole recording at once.",
    provider: 'gemini',
    apiModel: 'gemini-flash-latest'
  }),
  cloudEntry({
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description: 'Stable Gemini Flash model for whole-recording transcription.',
    provider: 'gemini',
    apiModel: 'gemini-2.5-flash'
  }),
  cloudEntry({
    id: 'gemini-flash-lite-latest',
    label: 'Gemini Flash-Lite (latest)',
    description: 'Fastest, lowest-cost Gemini model for whole-recording transcription.',
    provider: 'gemini',
    apiModel: 'gemini-flash-lite-latest'
  }),
  cloudEntry({
    id: 'gemini-pro-latest',
    label: 'Gemini Pro (latest)',
    description: 'Most capable Gemini model; slower, for difficult audio.',
    provider: 'gemini',
    apiModel: 'gemini-pro-latest'
  }),
  cloudEntry({
    id: 'groq-whisper-large-v3-turbo',
    label: 'Whisper Large v3 Turbo',
    description: 'Whisper on Groq hardware: very fast, low cost.',
    provider: 'groq',
    apiModel: 'whisper-large-v3-turbo'
  }),
  cloudEntry({
    id: 'groq-whisper-large-v3',
    label: 'Whisper Large v3',
    description: 'Full Whisper Large v3 on Groq for the best Whisper accuracy.',
    provider: 'groq',
    apiModel: 'whisper-large-v3'
  }),
  cloudEntry({
    id: 'mistral-voxtral-mini',
    label: 'Voxtral Mini',
    description: 'Mistral Voxtral transcription of the whole recording.',
    provider: 'mistral',
    apiModel: 'voxtral-mini-latest',
    transcriptionLanguages: VOXTRAL_TRANSCRIPTION_LANGUAGES
  })
]

export const CLOUD_SPEECH_MODEL_CATALOG: SpeechModelManifest[] = CLOUD_ENTRIES.map(
  (entry) => entry.manifest
)

const API_MODEL_BY_ID = new Map(CLOUD_ENTRIES.map((entry) => [entry.manifest.id, entry.apiModel]))

export function getCloudSpeechApiModel(modelId: string): string | undefined {
  return API_MODEL_BY_ID.get(modelId)
}
