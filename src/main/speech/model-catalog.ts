import type { SpeechModelManifest } from '../../shared/speech-types'

export const SPEECH_MODEL_CATALOG: SpeechModelManifest[] = [
  {
    id: 'parakeet-tdt-0.6b-v3-int8',
    label: 'Parakeet TDT v3',
    description: 'Best English accuracy. Offline — transcribes after you stop speaking.',
    type: 'transducer',
    language: 'en',
    sizeBytes: 180_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    archiveFormat: 'tar.bz2',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'parakeet-tdt-0.6b-v2-int8',
    label: 'Parakeet TDT v2',
    description: 'Strong English accuracy. Offline — lighter than v3.',
    type: 'transducer',
    language: 'en',
    sizeBytes: 170_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    archiveFormat: 'tar.bz2',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'zipformer-bilingual-zh-en',
    label: 'Zipformer Bilingual',
    description: 'Chinese + English. Streams text as you speak.',
    type: 'transducer',
    language: 'zh-en',
    sizeBytes: 130_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2',
    archiveFormat: 'tar.bz2',
    files: [
      'encoder-epoch-99-avg-1.onnx',
      'decoder-epoch-99-avg-1.onnx',
      'joiner-epoch-99-avg-1.onnx',
      'tokens.txt'
    ],
    sampleRate: 16000,
    streaming: true
  },
  {
    id: 'paraformer-bilingual-zh-en',
    label: 'Paraformer Bilingual',
    description: 'Chinese + English. Fastest streaming, smallest model.',
    type: 'paraformer',
    language: 'zh-en',
    sizeBytes: 115_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2',
    archiveFormat: 'tar.bz2',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt'],
    sampleRate: 16000,
    streaming: true
  },
  {
    id: 'zipformer-streaming-en-20m',
    label: 'Zipformer Streaming EN',
    description: 'English streaming. Lightweight 20M-param model for real-time dictation.',
    type: 'transducer',
    language: 'en',
    sizeBytes: 128_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2',
    archiveFormat: 'tar.bz2',
    files: [
      'encoder-epoch-99-avg-1.onnx',
      'decoder-epoch-99-avg-1.onnx',
      'joiner-epoch-99-avg-1.onnx',
      'tokens.txt'
    ],
    sampleRate: 16000,
    streaming: true
  },
  {
    id: 'zipformer-streaming-zh-14m',
    label: 'Zipformer Streaming ZH',
    description: 'Chinese streaming. Tiny 14M-param model, fast real-time Mandarin.',
    type: 'transducer',
    language: 'zh',
    sizeBytes: 74_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2',
    archiveFormat: 'tar.bz2',
    files: [
      'encoder-epoch-99-avg-1.onnx',
      'decoder-epoch-99-avg-1.onnx',
      'joiner-epoch-99-avg-1.onnx',
      'tokens.txt'
    ],
    sampleRate: 16000,
    streaming: true
  },
  {
    id: 'whisper-tiny',
    label: 'Whisper Tiny',
    description: 'Multilingual (99+ languages). Offline — good accuracy across many languages.',
    type: 'whisper',
    language: 'multilingual',
    sizeBytes: 116_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2',
    archiveFormat: 'tar.bz2',
    files: ['tiny-encoder.onnx', 'tiny-decoder.onnx', 'tiny-tokens.txt'],
    sampleRate: 16000,
    streaming: false
  }
]

export function getCatalogModel(id: string): SpeechModelManifest | undefined {
  return SPEECH_MODEL_CATALOG.find((m) => m.id === id)
}
