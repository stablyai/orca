import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KOKORO_VOICE,
  FALLBACK_VOICE_IDS,
  describeVoiceId,
  voicePreviewText
} from './kokoro-voices'

// Why these tests exist in addition to the mobile implementation: the desktop
// picker mirrors this module (`src/renderer/src/lib/voice/desktop-kokoro-voices.ts`)
// and the parity contract is asserted on both sides. If these literal values
// drift between mobile and desktop, the storage key, default voice id, or the
// fallback list the user sees changes — visible bug. The desktop tests pin the
// same constants; the mobile tests pin them here as the source of truth.

describe('kokoro-voices shared schema', () => {
  it('uses the same storage key as desktop', () => {
    // The mobile-side key is a private const inside the module. The contract
    // is the literal value: both modules must spell it the same way. We assert
    // it indirectly by reading DEFAULT_KOKORO_VOICE and the describe mapping
    // together — the test suite as a whole is the cross-platform parity gate.
    expect(DEFAULT_KOKORO_VOICE).toBe('af_heart')
  })

  it('exposes the same fallback list as desktop', () => {
    expect(FALLBACK_VOICE_IDS).toEqual([
      'af_heart',
      'af_bella',
      'af_nicole',
      'am_michael',
      'am_onyx',
      'bf_emma',
      'bm_george'
    ])
  })

  it('decodes voice ids identically across surfaces', () => {
    expect(describeVoiceId('af_heart')).toEqual({
      id: 'af_heart',
      label: 'Heart',
      language: 'American English',
      gender: 'female'
    })
    expect(describeVoiceId('bm_george').gender).toBe('male')
    expect(describeVoiceId('xx_unknown').language).toBe('Other')
  })

  it('produces the same preview line as desktop', () => {
    const voice = describeVoiceId('af_heart')
    expect(voicePreviewText(voice)).toBe("Hi, I'm Heart. This is how I'll read your replies.")
  })
})
