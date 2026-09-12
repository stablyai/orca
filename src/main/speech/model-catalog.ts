import type { SpeechModelManifest } from '../../shared/speech-types'
import { getSpeechModelDownloadMetadata } from './model-download-catalog'

export const SPEECH_MODEL_CATALOG: SpeechModelManifest[] = [
  {
    id: 'parakeet-tdt-0.6b-v3-int8',
    label: 'Parakeet TDT v3',
    description:
      'Highest accuracy for 25 European languages. Punctuation, capitalization, and word-level timestamps.',
    type: 'transducer',
    provider: 'local',
    language: 'multilingual',
    ...getSpeechModelDownloadMetadata('parakeet-tdt-0.6b-v3-int8'),
    sampleRate: 16000,
    streaming: false,
    modelingUnit: 'bpe',
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
    ...getSpeechModelDownloadMetadata('parakeet-tdt-0.6b-v2-int8'),
    sampleRate: 16000,
    streaming: false,
    modelingUnit: 'bpe'
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
    modelingUnit: 'cjkchar+bpe'
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
    streaming: true
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
    modelingUnit: 'bpe'
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
    modelingUnit: 'cjkchar'
  },
  {
    // Why: the recommended Parakeet multilingual set is European-only; Korean users need a local offline transducer (#10103).
    id: 'zipformer-korean-2024-06-24',
    label: 'Zipformer Korean',
    description:
      'Korean only. Offline int8 transducer from k2-fsa; accurate dictation on modest CPUs.',
    type: 'transducer',
    provider: 'local',
    language: 'ko',
    sizeBytes: 329_740_690,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-korean-2024-06-24.tar.bz2',
    archiveSha256: '24bd409318f389cd2de0e295eb1acf91f4e8dfcc0d650490dd2a01f5b50d2c77',
    archiveFormat: 'tar.bz2',
    files: [
      'encoder-epoch-99-avg-1.int8.onnx',
      'decoder-epoch-99-avg-1.int8.onnx',
      'joiner-epoch-99-avg-1.int8.onnx',
      'tokens.txt'
    ],
    sampleRate: 16000,
    streaming: false,
    modelingUnit: 'bpe'
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
    modelingUnit: 'bpe'
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
    streaming: false
  },
  {
    id: 'whisper-tiny',
    label: 'Whisper Tiny',
    description: '90+ languages. Lower accuracy than Parakeet but broadest language coverage.',
    type: 'whisper',
    provider: 'local',
    language: 'multilingual',
    ...getSpeechModelDownloadMetadata('whisper-tiny'),
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
    ...getSpeechModelDownloadMetadata('sense-voice-zh-en-ja-ko-yue'),
    sampleRate: 16000,
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
