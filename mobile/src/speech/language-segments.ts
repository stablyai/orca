import { readerWords, voiceLanguage } from './reader-words'
import { voiceNativeModule } from './voice-native-module'

// Why: only whole sentences switch voice, as a switch mid-sentence sounds like two speakers.
// Unsure ones stay with the reading voice: a foreign voice misreading it is far worse.
export type LanguageSegment = {
  text: string
  /** Primary language subtag, or null for the reading voice. */
  language: string | null
}

export type LanguageGuess = { language: string; confidence: number }

const MIN_WORDS = 4
const MIN_CJK_CHARACTERS = 4
export const MIN_CONFIDENCE = 0.8

let enabled = true

export function setLanguageVoices(on: boolean): void {
  enabled = on
}

export function primaryLanguage(tag: string): string | null {
  const primary = (tag.split(/[-_]/)[0] ?? '').toLowerCase()
  return primary && primary !== 'und' ? primary : null
}

/** At sentence ends followed by a space, and after CJK full stops, which take none. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|(?<=[。！？])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/g

export function longEnoughToGuess(sentence: string): boolean {
  const words = sentence.match(/\p{L}+/gu)?.length ?? 0
  const cjk = sentence.match(CJK)?.length ?? 0
  return words >= MIN_WORDS || cjk >= MIN_CJK_CHARACTERS
}

const KANA = /[぀-ヿ]/
const HANGUL = /[가-힯]/

// Words that are common in one language and not words at all in the other.
const POLISH_WORDS = new Set(
  'się że nie jest są już też jak ale czy dla przez oraz tylko jeszcze bardzo może można trzeba teraz tak był była było będzie który która które gdzie kiedy więc albo żeby jestem mamy'.split(
    ' '
  )
)
const ENGLISH_WORDS = new Set(
  'the and is are was were of for with that this it be have has you not but from will can should would what which there if or an your they we been into than then when about'.split(
    ' '
  )
)

/**
 * CJK by script, Polish against English by common words: stands in before Android 10, and keeps a
 * clearly Polish sentence Polish whatever the phone guessed.
 */
export function guessFromText(sentence: string): LanguageGuess | null {
  const letters = sentence.match(/\p{L}/gu)?.length ?? 0
  if (letters === 0) {
    return null
  }
  if ((sentence.match(CJK)?.length ?? 0) * 2 >= letters) {
    // Japanese is often mostly Han, so any kana tells it from Chinese.
    const language = KANA.test(sentence) ? 'ja' : HANGUL.test(sentence) ? 'ko' : 'zh'
    return { language, confidence: 0.9 }
  }
  const words = sentence.toLowerCase().match(/\p{L}+/gu) ?? []
  let polish = 0
  let english = 0
  for (const word of words) {
    if (POLISH_WORDS.has(word) || /[ąćęłńśźż]/.test(word)) {
      polish += 1
    } else if (ENGLISH_WORDS.has(word)) {
      english += 1
    }
  }
  const top = Math.max(polish, english)
  if (top < 2 || top < 2 * Math.min(polish, english)) {
    return null
  }
  return { language: polish > english ? 'pl' : 'en', confidence: 0.9 }
}

/**
 * The phone's confident guess unless the text clearly is `base`; null when unsure or short.
 * `cues`, the reader's own words, are `base`: a short one would otherwise join a foreign run.
 */
export function sentenceLanguages(
  sentences: string[],
  base: string,
  phoneGuesses: (texts: string[]) => (LanguageGuess | null)[],
  cues: readonly string[] = []
): (string | null)[] {
  const guessable = (sentence: string) => !cues.includes(sentence) && longEnoughToGuess(sentence)
  const asked = sentences.filter(guessable)
  const answers = asked.length > 0 ? phoneGuesses(asked) : []
  let next = 0
  return sentences.map((sentence) => {
    if (cues.includes(sentence)) {
      return base
    }
    if (!guessable(sentence)) {
      return null
    }
    const phone = answers[next++] ?? null
    const own = guessFromText(sentence)
    if (own?.language === base) {
      return base
    }
    const guess = phone && phone.confidence >= MIN_CONFIDENCE ? phone : own
    return guess ? primaryLanguage(guess.language) : null
  })
}

/**
 * An unsure sentence between two of the same language joins them, so a short "Done." inside an
 * English paragraph does not flip the voice twice; other unsure ones get the reading voice.
 */
export function planLanguages(
  sentences: string[],
  languages: (string | null)[],
  base: string
): LanguageSegment[] {
  const resolved = sentences.map((_, index) => {
    const own = languages[index] ?? null
    if (own !== null) {
      return own
    }
    const before = languages.slice(0, index).findLast((language) => language !== null) ?? null
    const after = languages.slice(index + 1).find((language) => language !== null) ?? null
    return before !== null && before === after ? before : base
  })
  const segments: LanguageSegment[] = []
  sentences.forEach((sentence, index) => {
    const language = resolved[index] === base ? null : (resolved[index] ?? null)
    const last = segments.at(-1)
    if (last && last.language === language) {
      last.text = `${last.text} ${sentence}`
    } else {
      segments.push({ text: sentence, language })
    }
  })
  return segments
}

/** Speech text in runs to read with one voice each; one run when switching is off or unknown. */
export function languageSegments(text: string): LanguageSegment[] {
  const whole = [{ text, language: null }]
  const native = voiceNativeModule()
  const voice = voiceLanguage()
  const base = voice ? primaryLanguage(voice) : null
  if (!enabled || native === null || base === null) {
    return whole
  }
  const sentences = splitSentences(text)
  if (sentences.length === 0) {
    return whole
  }
  const { code, table } = readerWords()
  const detect = (texts: string[]) => {
    try {
      return native.detectLanguages(texts)
    } catch {
      return []
    }
  }
  return planLanguages(sentences, sentenceLanguages(sentences, base, detect, [code, table]), base)
}
