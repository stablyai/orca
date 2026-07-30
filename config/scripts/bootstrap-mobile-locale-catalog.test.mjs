import { describe, expect, it } from 'vitest'

import {
  parseTranslationPayload,
  repairMobileTranslatedValue,
  shouldReuseDesktopTranslation
} from './bootstrap-mobile-locale-catalog.mjs'

describe('parseTranslationPayload', () => {
  it('joins valid translation segments', () => {
    expect(
      parseTranslationPayload([
        [
          ['Hello', 'Hola'],
          [' world', ' mundo']
        ]
      ])
    ).toBe('Hello world')
  })

  it('rejects a missing payload[0]', () => {
    expect(() => parseTranslationPayload([])).toThrow('non-empty segment array at payload[0]')
  })

  it('rejects segments without a string first item', () => {
    expect(() => parseTranslationPayload([[['Hello'], [42, 'invalid']]])).toThrow(
      'segment 1 must have a string first item'
    )
  })
})

describe('bootstrap-mobile-locale-catalog', () => {
  it('does not seed untranslated desktop actions as translations', () => {
    expect(shouldReuseDesktopTranslation('Stop', 'Stop')).toBe(false)
    expect(shouldReuseDesktopTranslation('Connecting…', 'Connecting…')).toBe(false)
    expect(shouldReuseDesktopTranslation('Codex', 'Codex')).toBe(true)
  })

  it('uses contextual overrides without translating the Continue agent name', () => {
    expect(
      repairMobileTranslatedValue({
        key: 'm.Scz67W0',
        enValue: 'Continue',
        localeValue: 'Continue',
        locale: 'es'
      })
    ).toBe('Continuar')
    expect(
      repairMobileTranslatedValue({
        key: 'm.dSfrwic',
        enValue: 'Continue',
        localeValue: 'Continuar',
        locale: 'es'
      })
    ).toBe('Continue')
    expect(
      repairMobileTranslatedValue({
        key: 'm.EiCMRDA',
        enValue: 'Unstaged',
        localeValue: 'sin escena',
        locale: 'es'
      })
    ).toBe('Sin preparar')
  })
})
