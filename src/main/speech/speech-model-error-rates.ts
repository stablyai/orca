import type { SpeechModelErrorRate } from '../../shared/speech-types'

type Measured = readonly [language: string, percent: number, measuredOn: string]

const LIBRISPEECH_CLIPS = 73
const FLEURS_CLIPS = 5
const CHARACTER_SCORED = new Set(['ja', 'ko', 'zh'])

// Orca's speech bench: transcribe-cpp 0.4.1 with Metal on an M4 Max, the catalog's pinned GGUF
// files, one run per clip. English is LibriSpeech (73 clips); other languages are FLEURS dev
// (5 clips each, so rough). Each clip's language was sent the way Orca sends it; Parakeet ignores it.
const MEASURED = {
  'parakeet-tdt-0.6b-v3-int8': [
    ['en', 3.7, '2026-11-06'],
    ['de', 2.2, '2026-11-06'],
    ['es', 1.7, '2026-11-06'],
    ['fr', 8.3, '2026-11-09'],
    ['pt', 11.3, '2026-11-09'],
    ['ru', 3.4, '2026-11-06']
  ],
  'parakeet-tdt-0.6b-v2-int8': [['en', 2.8, '2026-11-06']],
  'whisper-tiny': [
    ['en', 13, '2026-11-09'],
    ['de', 10, '2026-11-09'],
    ['es', 13.6, '2026-11-09'],
    ['fr', 52.3, '2026-11-09'],
    ['ja', 69.3, '2026-11-09'],
    ['ko', 24.9, '2026-11-09'],
    ['pt', 31.1, '2026-11-09'],
    ['ru', 38.2, '2026-11-09'],
    ['tr', 49.5, '2026-11-09'],
    ['zh', 47.5, '2026-11-09']
  ],
  'whisper-large-v3-turbo': [
    ['en', 4.5, '2026-11-09'],
    ['de', 1.1, '2026-11-09'],
    ['es', 1.7, '2026-11-09'],
    ['fr', 5.3, '2026-11-09'],
    ['ja', 7.4, '2026-11-09'],
    ['ko', 2.6, '2026-11-09'],
    ['pt', 8.5, '2026-11-09'],
    ['ru', 3.4, '2026-11-09'],
    ['tr', 7.7, '2026-11-09'],
    ['zh', 9.4, '2026-11-09']
  ],
  'sense-voice-zh-en-ja-ko-yue': [
    ['en', 6.9, '2026-11-09'],
    ['ja', 10.7, '2026-11-09'],
    ['ko', 10, '2026-11-09'],
    ['zh', 12.9, '2026-11-09']
  ],
  'nemotron-3.5-asr-streaming-0.6b': [
    ['en', 5.3, '2026-11-09'],
    ['de', 5.6, '2026-11-09'],
    ['es', 2.5, '2026-11-09'],
    ['fr', 9.8, '2026-11-09'],
    ['ja', 17.2, '2026-11-09'],
    ['ko', 11.8, '2026-11-09'],
    ['pt', 13.2, '2026-11-09'],
    ['ru', 14.6, '2026-11-09'],
    ['tr', 14.3, '2026-11-09'],
    ['zh', 17.3, '2026-11-09']
  ]
} satisfies Record<string, readonly Measured[]>

export function getSpeechModelErrorRates(modelId: keyof typeof MEASURED): {
  errorRates: SpeechModelErrorRate[]
} {
  return {
    errorRates: MEASURED[modelId].map(([language, percent, measuredOn]) => ({
      language,
      percent,
      metric: CHARACTER_SCORED.has(language) ? 'cer' : 'wer',
      test: language === 'en' ? 'librispeech' : 'fleurs',
      clips: language === 'en' ? LIBRISPEECH_CLIPS : FLEURS_CLIPS,
      measuredOn
    }))
  }
}
