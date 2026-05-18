import type { SpeechModelManifest } from '../../shared/speech-types'

export const SPEECH_MODEL_CATALOG: SpeechModelManifest[] = [
  {
    id: 'parakeet-tdt-0.6b-v3-int8',
    label: 'Parakeet TDT v3',
    description:
      'Highest accuracy for 25 European languages. Punctuation, capitalization, and word-level timestamps.',
    type: 'transducer',
    language: 'multilingual',
    sizeBytes: 180_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    archiveSha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
    archiveFormat: 'tar.bz2',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
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
    language: 'en',
    sizeBytes: 170_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    archiveSha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
    archiveFormat: 'tar.bz2',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    sampleRate: 16000,
    streaming: false,
    modelingUnit: 'bpe'
  },
  {
    id: 'zipformer-bilingual-zh-en',
    label: 'Zipformer Bilingual',
    description: 'Chinese + English with code-switching. Low-latency real-time streaming.',
    type: 'transducer',
    language: 'zh-en',
    sizeBytes: 130_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2',
    archiveSha256: '27ffbd9ee24ad186d99acc2f6354d7992b27bcab490812510665fa8f9389c5f8',
    archiveFormat: 'tar.bz2',
    files: [
      'encoder-epoch-99-avg-1.onnx',
      'decoder-epoch-99-avg-1.onnx',
      'joiner-epoch-99-avg-1.onnx',
      'tokens.txt'
    ],
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
    language: 'zh-en',
    sizeBytes: 115_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2',
    archiveSha256: '5462a1fce42693deae572af1e8c4687124b12aa85fe61ff4d3168bb5280e205f',
    archiveFormat: 'tar.bz2',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt'],
    sampleRate: 16000,
    streaming: true
  },
  {
    id: 'zipformer-streaming-en-20m',
    label: 'Zipformer Streaming EN',
    description: 'English only. Lightweight 20M-param model, good balance of speed and size.',
    type: 'transducer',
    language: 'en',
    sizeBytes: 128_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2',
    archiveSha256: '9c559283e8498d3fe95913c79ca1cb454bb26281ac2b102b41306c7d752765d9',
    archiveFormat: 'tar.bz2',
    files: [
      'encoder-epoch-99-avg-1.onnx',
      'decoder-epoch-99-avg-1.onnx',
      'joiner-epoch-99-avg-1.onnx',
      'tokens.txt'
    ],
    sampleRate: 16000,
    streaming: true,
    modelingUnit: 'bpe'
  },
  {
    id: 'zipformer-streaming-zh-14m',
    label: 'Zipformer Streaming ZH',
    description: 'Chinese only. Ultra-lightweight 14M-param model, ideal for low-resource devices.',
    type: 'transducer',
    language: 'zh',
    sizeBytes: 74_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2',
    archiveSha256: '2cbd71b640d9c37d3784f29367333a4577b0398b62e9deeed418170b081cba8b',
    archiveFormat: 'tar.bz2',
    files: [
      'encoder-epoch-99-avg-1.onnx',
      'decoder-epoch-99-avg-1.onnx',
      'joiner-epoch-99-avg-1.onnx',
      'tokens.txt'
    ],
    sampleRate: 16000,
    streaming: true,
    modelingUnit: 'cjkchar'
  },
  {
    id: 'whisper-tiny',
    label: 'Whisper Tiny',
    description: '90+ languages. Lower accuracy than Parakeet but broadest language coverage.',
    type: 'whisper',
    language: 'multilingual',
    sizeBytes: 116_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2',
    archiveSha256: 'c46116994e539aa165266d96b325252728429c12535eb9d8b6a2b10f129e66b1',
    archiveFormat: 'tar.bz2',
    files: ['tiny-encoder.onnx', 'tiny-decoder.onnx', 'tiny-tokens.txt'],
    sampleRate: 16000,
    streaming: false
  }
]

export function getCatalogModel(id: string): SpeechModelManifest | undefined {
  return SPEECH_MODEL_CATALOG.find((m) => m.id === id)
}
