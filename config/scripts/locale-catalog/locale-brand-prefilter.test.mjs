import { describe, expect, it, vi } from 'vitest'
import { repairTranslatedValue } from './locale-translation-policy.mjs'

describe('locale brand matching', () => {
  it('does not construct boundary expressions for absent brands', () => {
    let boundaryExpressions = 0
    vi.stubGlobal(
      'RegExp',
      new Proxy(RegExp, {
        construct(target, args) {
          if (typeof args[0] === 'string' && args[0].startsWith('(^|[^A-Za-z_])')) {
            boundaryExpressions += 1
          }
          return Reflect.construct(target, args)
        }
      })
    )
    try {
      for (const locale of ['zh', 'ja', 'ko', 'es']) {
        expect(
          repairTranslatedValue({
            key: 'fixture.endpoint',
            enValue: 'Choose an endpoint.',
            localeValue: 'fixture translation',
            locale
          })
        ).toBe('fixture translation')
      }
    } finally {
      vi.unstubAllGlobals()
    }
    expect(boundaryExpressions).toBe(0)
  })

  it.each([
    ['Use Gemini.', 'Usar Géminis.', 'Usar Gemini.'],
    ['Use GeminiX.', 'Usar Géminis.', 'Usar Géminis.'],
    ['Use XGemini.', 'Usar Géminis.', 'Usar Géminis.'],
    ['Use _Gemini_.', 'Usar Géminis.', 'Usar Géminis.'],
    ['Use Gemini_2.', 'Usar Géminis.', 'Usar Géminis.'],
    ['Use 2Gemini3.', 'Usar Géminis.', 'Usar Gemini.'],
    ['Use (Gemini).', 'Usar Géminis.', 'Usar Gemini.'],
    ['Use éGemini界.', 'Usar Géminis.', 'Usar Gemini.'],
    ['Use gemini.', 'Usar Géminis.', 'Usar Géminis.'],
    ['Use GeminiX and Gemini.', 'Usar Géminis.', 'Usar Gemini.'],
    ['Use Gemini.', 'Gemini y Géminis.', 'Gemini y Géminis.'],
    ['Use Gemini.', '_Gemini_ y Géminis.', '_Gemini_ y Gemini.'],
    ['Use GitHub Copilot.', 'Usar Copiloto de GitHub.', 'Usar GitHub Copilot.'],
    ['Use XGitHub CopilotY.', 'Usar Copiloto de GitHub.', 'Usar GitHub Copilot.']
  ])('preserves literal and boundary matching for %j / %j', (enValue, localeValue, expected) => {
    expect(
      repairTranslatedValue({ key: 'fixture.brand', enValue, localeValue, locale: 'es' })
    ).toBe(expected)
  })
})
