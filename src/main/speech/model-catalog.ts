import type { SpeechModelManifest } from '../../shared/speech-types'
import {
  DICTATION_LANGUAGES,
  NEMOTRON_DICTATION_LANGUAGES,
  PARAKEET_V3_LANGUAGES,
  SENSE_VOICE_DICTATION_LANGUAGES,
  WHISPER_LANGUAGES
} from '../../shared/dictation-language'
import { getSpeechModelDownloadMetadata } from './model-download-catalog'
import { getGgufSpeechModelDownload } from './speech-model-gguf-downloads'
import { getSpeechModelErrorRates } from './speech-model-error-rates'

const legacy = (id: Parameters<typeof getSpeechModelDownloadMetadata>[0]) => ({
  legacyDownloadFiles: getSpeechModelDownloadMetadata(id).downloadFiles
})

export const SPEECH_MODEL_CATALOG: SpeechModelManifest[] = [
  {
    id: 'parakeet-tdt-0.6b-v3-int8',
    label: 'Parakeet TDT v3',
    type: 'transducer',
    provider: 'local',
    language: 'multilingual',
    ...getGgufSpeechModelDownload('parakeet-tdt-0.6b-v3-int8'),
    ...legacy('parakeet-tdt-0.6b-v3-int8'),
    languages: PARAKEET_V3_LANGUAGES,
    ...getSpeechModelErrorRates('parakeet-tdt-0.6b-v3-int8'),
    licence: 'CC-BY-4.0',
    sampleRate: 16000,
    streaming: false,
    recommended: true
  },
  {
    id: 'parakeet-tdt-0.6b-v2-int8',
    label: 'Parakeet TDT v2',
    type: 'transducer',
    provider: 'local',
    language: 'en',
    ...getGgufSpeechModelDownload('parakeet-tdt-0.6b-v2-int8'),
    ...legacy('parakeet-tdt-0.6b-v2-int8'),
    languages: ['en'],
    ...getSpeechModelErrorRates('parakeet-tdt-0.6b-v2-int8'),
    licence: 'CC-BY-4.0',
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'zipformer-bilingual-zh-en',
    label: 'Zipformer Bilingual',
    type: 'transducer',
    provider: 'local',
    language: 'zh-en',
    ...getSpeechModelDownloadMetadata('zipformer-bilingual-zh-en'),
    languages: ['zh', 'en'],
    sampleRate: 16000,
    streaming: true,
    // transcribe-cpp has no zipformer; SenseVoice covers Chinese and English.
    replacedBy: 'sense-voice-zh-en-ja-ko-yue'
  },
  {
    id: 'paraformer-bilingual-zh-en',
    label: 'Paraformer Bilingual',
    type: 'paraformer',
    provider: 'local',
    language: 'zh-en',
    ...getSpeechModelDownloadMetadata('paraformer-bilingual-zh-en'),
    languages: ['zh', 'en'],
    sampleRate: 16000,
    streaming: true,
    // transcribe-cpp has no paraformer; SenseVoice covers Chinese and English.
    replacedBy: 'sense-voice-zh-en-ja-ko-yue'
  },
  {
    id: 'zipformer-streaming-en-20m',
    label: 'Zipformer Streaming EN',
    type: 'transducer',
    provider: 'local',
    language: 'en',
    ...getSpeechModelDownloadMetadata('zipformer-streaming-en-20m'),
    languages: ['en'],
    sampleRate: 16000,
    streaming: true,
    // The model itself loses the first words of every utterance.
    replacedBy: 'parakeet-tdt-0.6b-v2-int8'
  },
  {
    id: 'zipformer-streaming-zh-14m',
    label: 'Zipformer Streaming ZH',
    type: 'transducer',
    provider: 'local',
    language: 'zh',
    ...getSpeechModelDownloadMetadata('zipformer-streaming-zh-14m'),
    languages: ['zh'],
    sampleRate: 16000,
    streaming: true,
    // transcribe-cpp has no zipformer; SenseVoice beat Nemotron 3.5 on Korean and Chinese.
    replacedBy: 'sense-voice-zh-en-ja-ko-yue'
  },
  {
    id: 'zipformer-streaming-korean',
    label: 'Zipformer Streaming KO',
    type: 'transducer',
    provider: 'local',
    language: 'ko',
    ...getSpeechModelDownloadMetadata('zipformer-streaming-korean'),
    languages: ['ko'],
    sampleRate: 16000,
    streaming: true,
    // transcribe-cpp has no zipformer; SenseVoice beat Nemotron 3.5 on Korean and Chinese.
    replacedBy: 'sense-voice-zh-en-ja-ko-yue'
  },
  {
    id: 'parakeet-tdt-ctc-0.6b-ja-int8',
    label: 'Parakeet TDT-CTC JA',
    type: 'nemo-ctc',
    provider: 'local',
    language: 'ja',
    ...getSpeechModelDownloadMetadata('parakeet-tdt-ctc-0.6b-ja-int8'),
    languages: ['ja'],
    sampleRate: 16000,
    streaming: false,
    // No GGUF conversion exists; SenseVoice covers Japanese.
    replacedBy: 'sense-voice-zh-en-ja-ko-yue'
  },
  {
    id: 'whisper-tiny',
    label: 'Whisper Tiny',
    type: 'whisper',
    provider: 'local',
    language: 'multilingual',
    ...getGgufSpeechModelDownload('whisper-tiny'),
    ...legacy('whisper-tiny'),
    dictationLanguages: DICTATION_LANGUAGES,
    languages: WHISPER_LANGUAGES,
    ...getSpeechModelErrorRates('whisper-tiny'),
    licence: 'Apache-2.0',
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper Large v3 Turbo',
    type: 'whisper',
    provider: 'local',
    language: 'multilingual',
    ...getGgufSpeechModelDownload('whisper-large-v3-turbo'),
    dictationLanguages: DICTATION_LANGUAGES,
    languages: [...WHISPER_LANGUAGES, 'yue'],
    ...getSpeechModelErrorRates('whisper-large-v3-turbo'),
    licence: 'MIT',
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'sense-voice-zh-en-ja-ko-yue',
    label: 'SenseVoice',
    type: 'senseVoice',
    provider: 'local',
    language: 'multilingual',
    ...getGgufSpeechModelDownload('sense-voice-zh-en-ja-ko-yue'),
    ...legacy('sense-voice-zh-en-ja-ko-yue'),
    dictationLanguages: SENSE_VOICE_DICTATION_LANGUAGES,
    languages: SENSE_VOICE_DICTATION_LANGUAGES,
    ...getSpeechModelErrorRates('sense-voice-zh-en-ja-ko-yue'),
    licence: 'FunASR Model License',
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'nemotron-3.5-asr-streaming-0.6b',
    label: 'Nemotron 3.5',
    type: 'transducer',
    provider: 'local',
    language: 'multilingual',
    ...getGgufSpeechModelDownload('nemotron-3.5-asr-streaming-0.6b'),
    dictationLanguages: NEMOTRON_DICTATION_LANGUAGES,
    languages: NEMOTRON_DICTATION_LANGUAGES,
    ...getSpeechModelErrorRates('nemotron-3.5-asr-streaming-0.6b'),
    licence: 'OpenMDW-1.1',
    sampleRate: 16000,
    // Decoded per chunk for now; live text arrives with the streaming engine path.
    streaming: false
  },
  {
    id: 'openai-gpt-transcribe',
    label: 'GPT Transcribe',
    type: 'openai',
    provider: 'openai',
    language: 'multilingual',
    dictationLanguages: DICTATION_LANGUAGES,
    languages: DICTATION_LANGUAGES,
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    type: 'openai',
    provider: 'openai-compatible',
    language: 'multilingual',
    dictationLanguages: DICTATION_LANGUAGES,
    languages: DICTATION_LANGUAGES,
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'openai-gpt-4o-mini-transcribe',
    label: 'GPT-4o mini Transcribe',
    type: 'openai',
    provider: 'openai',
    language: 'multilingual',
    dictationLanguages: DICTATION_LANGUAGES,
    languages: DICTATION_LANGUAGES,
    sampleRate: 16000,
    streaming: false,
    // OpenAI shuts the gpt-4o transcribe models down on 2027-02-26.
    replacedBy: 'openai-gpt-transcribe'
  },
  {
    id: 'openai-gpt-4o-transcribe',
    label: 'GPT-4o Transcribe',
    type: 'openai',
    provider: 'openai',
    language: 'multilingual',
    dictationLanguages: DICTATION_LANGUAGES,
    languages: DICTATION_LANGUAGES,
    sampleRate: 16000,
    streaming: false,
    replacedBy: 'openai-gpt-transcribe'
  }
]

export function getCatalogModel(id: string): SpeechModelManifest | undefined {
  return SPEECH_MODEL_CATALOG.find((m) => m.id === id)
}

export function isLocalSpeechModel(manifest: SpeechModelManifest): boolean {
  return manifest.provider === 'local'
}

export function replaceRetiredSpeechModelId(id: string): string {
  return getCatalogModel(id)?.replacedBy ?? id
}
