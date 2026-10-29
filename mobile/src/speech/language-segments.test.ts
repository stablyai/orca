import { describe, expect, it, vi } from 'vitest'
import {
  guessFromText,
  languageSegments,
  planLanguages,
  sentenceLanguages,
  splitSentences,
  type LanguageGuess
} from './language-segments'
import { READER_WORDS } from './reader-words'

const native = {
  getSpeechOptions: () => ({ rate: null, voice: null, phoneRate: 1, language: 'pl-PL' }),
  detectLanguages: (texts: string[]) => texts.map(() => ({ language: 'en', confidence: 0.95 }))
}
vi.mock('./voice-native-module', () => ({ voiceNativeModule: () => native }))

const POLISH = 'Zbudowałem nową wersję aplikacji i wystawiłem ją na GitHubie.'
const ENGLISH = 'The build failed because the signing key is missing from the config.'

function phoneSays(answers: Record<string, LanguageGuess | null>) {
  return (texts: string[]) => texts.map((text) => answers[text] ?? null)
}

describe('splitSentences', () => {
  it('splits at sentence ends followed by a space, not inside version numbers', () => {
    expect(splitSentences('Gotowe. Wersja 1.4.243 działa! Czy coś jeszcze?')).toEqual([
      'Gotowe.',
      'Wersja 1.4.243 działa!',
      'Czy coś jeszcze?'
    ])
  })

  it('splits after CJK full stops, which take no space', () => {
    expect(splitSentences('構築しました。テストは成功です。')).toEqual([
      '構築しました。',
      'テストは成功です。'
    ])
  })
})

describe('guessFromText', () => {
  it('tells Polish from English by common words and Polish letters', () => {
    expect(guessFromText(POLISH)?.language).toBe('pl')
    expect(guessFromText(ENGLISH)?.language).toBe('en')
  })

  it('keeps a Polish sentence full of English terms Polish', () => {
    expect(guessFromText('Commit jest już na branchu, a build przeszedł testy.')?.language).toBe(
      'pl'
    )
  })

  it('knows CJK scripts', () => {
    expect(guessFromText('テストは成功です。')?.language).toBe('ja')
    expect(guessFromText('测试已经通过了。')?.language).toBe('zh')
    expect(guessFromText('테스트가 통과했습니다.')?.language).toBe('ko')
  })

  it('takes any kana for Japanese and any hangul for Korean, however much Han there is', () => {
    expect(guessFromText('東京都知事選挙の結果発表。')?.language).toBe('ja')
    expect(guessFromText('大韓民國 憲法 헌법.')?.language).toBe('ko')
  })

  it('says nothing when the words do not tell', () => {
    expect(guessFromText('Build passed, deploy done.')).toBeNull()
  })
})

describe('sentenceLanguages', () => {
  it("takes the phone's confident guess", () => {
    const languages = sentenceLanguages(
      [POLISH, ENGLISH],
      'pl',
      phoneSays({
        [POLISH]: { language: 'pl', confidence: 0.99 },
        [ENGLISH]: { language: 'en', confidence: 0.95 }
      })
    )
    expect(languages).toEqual(['pl', 'en'])
  })

  it('ignores an unsure guess and short sentences', () => {
    const short = 'Done, all green.'
    const languages = sentenceLanguages(
      [short, 'Deploy rollout finished across every region today.'],
      'pl',
      phoneSays({
        'Deploy rollout finished across every region today.': { language: 'en', confidence: 0.6 }
      })
    )
    expect(languages).toEqual([null, null])
  })

  it('keeps a clearly Polish sentence Polish whatever the phone guessed', () => {
    const languages = sentenceLanguages(
      [POLISH],
      'pl',
      phoneSays({ [POLISH]: { language: 'en', confidence: 0.9 } })
    )
    expect(languages).toEqual(['pl'])
  })

  it('falls back to the writing where the phone cannot tell', () => {
    expect(sentenceLanguages([ENGLISH], 'pl', (texts) => texts.map(() => null))).toEqual(['en'])
  })
})

describe('planLanguages', () => {
  it('groups runs and gives the reading voice null', () => {
    expect(planLanguages(['A1.', 'A2.', 'B1.', 'A3.'], ['pl', 'pl', 'en', 'pl'], 'pl')).toEqual([
      { text: 'A1. A2.', language: null },
      { text: 'B1.', language: 'en' },
      { text: 'A3.', language: null }
    ])
  })

  it('lets an unsure sentence between two English ones stay English', () => {
    expect(planLanguages(['E1.', 'Done.', 'E2.'], ['en', null, 'en'], 'pl')).toEqual([
      { text: 'E1. Done. E2.', language: 'en' }
    ])
  })

  it('reads any other unsure sentence with the reading voice', () => {
    expect(planLanguages(['E1.', 'Naprawione.'], ['en', null], 'pl')).toEqual([
      { text: 'E1.', language: 'en' },
      { text: 'Naprawione.', language: null }
    ])
  })
})

describe('languageSegments', () => {
  it("reads the reader's own cue with the reading voice, even between English sentences", () => {
    const after = 'The tests pass now and the release is ready for review.'
    const cue = READER_WORDS.pl.code
    expect(languageSegments(`${ENGLISH} ${cue} ${after}`)).toEqual([
      { text: ENGLISH, language: 'en' },
      { text: cue, language: null },
      { text: after, language: 'en' }
    ])
  })
})
