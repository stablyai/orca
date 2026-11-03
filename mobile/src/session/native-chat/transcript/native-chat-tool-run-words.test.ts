import { describe, expect, it, vi } from 'vitest'
import type { SupportedUiLocale } from '../../../../../src/shared/ui-locale'
import {
  joinNativeChatToolRunClauses,
  nativeChatToolRunSentence
} from '../../../../../src/shared/native-chat/tools/native-chat-tool-run-sentence'
import { getMobileUiLocale } from '../../../i18n/mobile-i18n'
import { nativeChatToolRunWords } from './native-chat-tool-run-words'

vi.mock('../../../i18n/mobile-i18n', () => ({
  getMobileUiLocale: vi.fn(() => 'en')
}))

const joiners = {
  pair: (first: string, second: string) => `${first} | ${second}`,
  list: (leading: readonly string[], last: string) => [...leading, last].join(' | ')
}

function mobileWords(locale: SupportedUiLocale) {
  vi.mocked(getMobileUiLocale).mockReturnValue(locale)
  return { ...nativeChatToolRunWords((_key, fallback) => fallback), ...joiners }
}

describe('mobile tool-run sentence continuations', () => {
  it('keeps German noun capitalization through the sentence formatter', () => {
    const words = mobileWords('de')
    expect(
      nativeChatToolRunSentence(
        [
          { type: 'tool-call', name: 'read', input: {} },
          { type: 'tool-call', name: 'Bash', input: { command: 'orca snapshot --page p1' } }
        ],
        {},
        {
          ...words,
          clause: (category) => (category === 'browser' ? 'Browser verwendet' : 'Datei gelesen')
        }
      )
    ).toBe('Datei gelesen | Browser verwendet')
  })

  it('uses Turkish casing for both dotted and dotless I in later clauses', () => {
    expect(joinNativeChatToolRunClauses(['Başladı', 'İnceledi', 'Isındı'], mobileWords('tr'))).toBe(
      'Başladı | inceledi | ısındı'
    )
  })

  it.each<SupportedUiLocale>(['en', 'es', 'fr', 'pt', 'ru'])(
    'continues later clauses in %s',
    (locale) => {
      expect(joinNativeChatToolRunClauses(['Read', 'Searched'], mobileWords(locale))).toBe(
        'Read | searched'
      )
    }
  )

  it.each<SupportedUiLocale>(['ja', 'ko', 'zh', 'zh-Hant'])(
    'preserves clause text in %s',
    (locale) => {
      expect(joinNativeChatToolRunClauses(['開始', 'Browser'], mobileWords(locale))).toBe(
        '開始 | Browser'
      )
    }
  )

  it('retains the default casing when no continuation is supplied', () => {
    expect(joinNativeChatToolRunClauses(['Read', 'Searched', 'Edited'], joiners)).toBe(
      'Read | searched | edited'
    )
  })
})
