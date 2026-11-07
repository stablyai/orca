import type { SpeechModelManifest } from '../../shared/speech-types'
import {
  DICTATION_LANGUAGES,
  NEMOTRON_DICTATION_LANGUAGES,
  SENSE_VOICE_DICTATION_LANGUAGES
} from '../../shared/dictation-language'
import { getSpeechModelDownloadMetadata } from './model-download-catalog'
import { getGgufSpeechModelDownload } from './speech-model-gguf-downloads'

const legacy = (id: Parameters<typeof getSpeechModelDownloadMetadata>[0]) => ({
  legacyDownloadFiles: getSpeechModelDownloadMetadata(id).downloadFiles
})

export const SPEECH_MODEL_CATALOG: SpeechModelManifest[] = [
  {
    id: 'parakeet-tdt-0.6b-v3-int8',
    label: 'Parakeet TDT v3',
    description:
      'Highest accuracy for 25 European languages. Punctuation, capitalization, and word-level timestamps.',
    type: 'transducer',
    provider: 'local',
    language: 'multilingual',
    ...getGgufSpeechModelDownload('parakeet-tdt-0.6b-v3-int8'),
    ...legacy('parakeet-tdt-0.6b-v3-int8'),
    sampleRate: 16000,
    streaming: false,
    recommended: true
  },
  {
    id: 'parakeet-tdt-0.6b-v2-int8',
    label: 'Parakeet TDT v2',
    description:
      'English only. Faster than v3 with similar accuracy. Punctuation and capitalization.',
    type: 'transducer',
    provider: 'local',
    language: 'en',
    ...getGgufSpeechModelDownload('parakeet-tdt-0.6b-v2-int8'),
    ...legacy('parakeet-tdt-0.6b-v2-int8'),
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'zipformer-bilingual-zh-en',
    label: 'Zipformer Bilingual',
    description: 'Chinese + English with code-switching. Low-latency real-time streaming.',
    type: 'transducer',
    provider: 'local',
    language: 'zh-en',
    ...getSpeechModelDownloadMetadata('zipformer-bilingual-zh-en'),
    sampleRate: 16000,
    streaming: true,
    modelingUnit: 'cjkchar+bpe',
    // transcribe-cpp has no zipformer; SenseVoice covers Chinese and English.
    replacedBy: 'sense-voice-zh-en-ja-ko-yue'
  },
  {
    id: 'paraformer-bilingual-zh-en',
    label: 'Paraformer Bilingual',
    description:
      'Chinese (Mandarin + dialects) + English. Strong on accented and regional Chinese.',
    type: 'paraformer',
    provider: 'local',
    language: 'zh-en',
    ...getSpeechModelDownloadMetadata('paraformer-bilingual-zh-en'),
    sampleRate: 16000,
    streaming: true,
    // transcribe-cpp has no paraformer; SenseVoice covers Chinese and English.
    replacedBy: 'sense-voice-zh-en-ja-ko-yue'
  },
  {
    id: 'zipformer-streaming-en-20m',
    label: 'Zipformer Streaming EN',
    description: 'English only. Lightweight 20M-param model, good balance of speed and size.',
    type: 'transducer',
    provider: 'local',
    language: 'en',
    ...getSpeechModelDownloadMetadata('zipformer-streaming-en-20m'),
    sampleRate: 16000,
    streaming: true,
    modelingUnit: 'bpe',
    // The model itself loses the first words of every utterance.
    replacedBy: 'parakeet-tdt-0.6b-v2-int8'
  },
  {
    id: 'zipformer-streaming-zh-14m',
    label: 'Zipformer Streaming ZH',
    description: 'Chinese only. Ultra-lightweight 14M-param model, ideal for low-resource devices.',
    type: 'transducer',
    provider: 'local',
    language: 'zh',
    ...getSpeechModelDownloadMetadata('zipformer-streaming-zh-14m'),
    sampleRate: 16000,
    streaming: true,
    modelingUnit: 'cjkchar',
    // transcribe-cpp has no zipformer.
    replacedBy: 'nemotron-3.5-asr-streaming-0.6b'
  },
  {
    id: 'zipformer-streaming-korean',
    label: 'Zipformer Streaming KO',
    description: 'Korean only. Low-latency real-time streaming.',
    type: 'transducer',
    provider: 'local',
    language: 'ko',
    ...getSpeechModelDownloadMetadata('zipformer-streaming-korean'),
    sampleRate: 16000,
    streaming: true,
    modelingUnit: 'bpe',
    // transcribe-cpp has no zipformer.
    replacedBy: 'nemotron-3.5-asr-streaming-0.6b'
  },
  {
    id: 'parakeet-tdt-ctc-0.6b-ja-int8',
    label: 'Parakeet TDT-CTC JA',
    description: 'Japanese only. Trained on 35k+ hours of natural speech. Punctuation included.',
    type: 'nemo-ctc',
    provider: 'local',
    language: 'ja',
    ...getSpeechModelDownloadMetadata('parakeet-tdt-ctc-0.6b-ja-int8'),
    sampleRate: 16000,
    streaming: false,
    // No GGUF conversion exists; SenseVoice covers Japanese.
    replacedBy: 'sense-voice-zh-en-ja-ko-yue'
  },
  {
    id: 'whisper-tiny',
    label: 'Whisper Tiny',
    description: '90+ languages. Lower accuracy than Parakeet but broadest language coverage.',
    type: 'whisper',
    provider: 'local',
    language: 'multilingual',
    ...getGgufSpeechModelDownload('whisper-tiny'),
    ...legacy('whisper-tiny'),
    dictationLanguages: DICTATION_LANGUAGES,
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'sense-voice-zh-en-ja-ko-yue',
    label: 'SenseVoice',
    description:
      'Chinese, English, Japanese, Korean, and Cantonese with automatic language detection.',
    type: 'senseVoice',
    provider: 'local',
    language: 'multilingual',
    ...getGgufSpeechModelDownload('sense-voice-zh-en-ja-ko-yue'),
    ...legacy('sense-voice-zh-en-ja-ko-yue'),
    dictationLanguages: SENSE_VOICE_DICTATION_LANGUAGES,
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'nemotron-3.5-asr-streaming-0.6b',
    label: 'Nemotron 3.5',
    description:
      'Korean, Chinese, Japanese and many more languages, with automatic language detection.',
    type: 'transducer',
    provider: 'local',
    language: 'multilingual',
    ...getGgufSpeechModelDownload('nemotron-3.5-asr-streaming-0.6b'),
    dictationLanguages: NEMOTRON_DICTATION_LANGUAGES,
    sampleRate: 16000,
    // Decoded per chunk for now; live text arrives with the streaming engine path.
    streaming: false
  },
  {
    id: 'openai-gpt-4o-mini-transcribe',
    label: 'GPT-4o mini Transcribe',
    description:
      'Cloud transcription with strong accuracy and low cost. Requires an OpenAI API key.',
    type: 'openai',
    provider: 'openai',
    language: 'multilingual',
    dictationLanguages: DICTATION_LANGUAGES,
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'openai-gpt-4o-transcribe',
    label: 'GPT-4o Transcribe',
    description: 'Cloud transcription with higher accuracy. Requires an OpenAI API key.',
    type: 'openai',
    provider: 'openai',
    language: 'multilingual',
    dictationLanguages: DICTATION_LANGUAGES,
    sampleRate: 16000,
    streaming: false
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
