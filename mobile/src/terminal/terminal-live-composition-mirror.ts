// Why: paused composition should still reach the PTY quickly; corrections make
// a premature commit safe, so this can be short without leaking jamo forever.
export const TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS = 300

const TERMINAL_DEL_BYTE = '\x7f'

export function isTerminalLiveHangulCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af)
  )
}

// Why: Gboard's Japanese IME writes the *reading* into the field — pending romaji
// arrives as full-width Latin (`s` → U+FF53), then as kana — so preedit spans the
// whole trailing run, unlike Hangul which only mutates its last syllable (#7427).
const JAPANESE_PREEDIT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3041, 0x309f], // hiragana, including the voiced/iteration marks
  [0x30a0, 0x30ff], // katakana, including the ー prolonged sound mark
  [0x31f0, 0x31ff], // katakana phonetic extensions
  // Letters only: full-width punctuation is committed text for Chinese IMEs, which
  // compose in the candidate bar and must keep reaching the PTY immediately (#7495).
  [0xff21, 0xff3a], // full-width Ａ-Ｚ
  [0xff41, 0xff5a], // full-width ａ-ｚ: Gboard's pending romaji
  [0xff66, 0xff9f] // half-width katakana
]

export function isTerminalLiveJapanesePreeditCodePoint(codePoint: number): boolean {
  return JAPANESE_PREEDIT_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last)
}

type HeldRun = {
  readonly count: number
  // Why: a Hangul syllable is display-final, so a pause can safely commit it. A
  // Japanese reading is discarded the moment a candidate is picked (にほんご → 日本語),
  // so committing it on a pause is exactly the leak this holds back.
  readonly commitsOnPause: boolean
}

const NO_HELD_RUN: HeldRun = { count: 0, commitsOnPause: false }

// Why: kanji is deliberately excluded — it only appears once the user has picked a
// candidate, so holding it would delay committed text with nothing left to correct.
function measureHeldRun(fieldCodePoints: readonly string[]): HeldRun {
  const lastCodePoint = fieldCodePoints.at(-1)
  if (lastCodePoint === undefined) {
    return NO_HELD_RUN
  }
  if (isTerminalLiveHangulCodePoint(lastCodePoint.codePointAt(0) ?? 0)) {
    return { count: 1, commitsOnPause: true }
  }
  let count = 0
  while (count < fieldCodePoints.length) {
    const candidate = fieldCodePoints[fieldCodePoints.length - 1 - count]!
    if (!isTerminalLiveJapanesePreeditCodePoint(candidate.codePointAt(0) ?? 0)) {
      break
    }
    count += 1
  }
  return count > 0 ? { count, commitsOnPause: false } : NO_HELD_RUN
}

export type TerminalLiveMirrorStep = {
  readonly eraseCount: number
  readonly appendText: string
  readonly nextSentText: string
  readonly heldText: string
  /** Whether a settle-timer pause may commit `heldText`, or only an explicit flush. */
  readonly heldCommitsOnPause: boolean
}

// Why: React Native exposes no composition events, so the held run is inferred from
// the script of the trailing code points. Holding it keeps the PTY echo live while
// preedit never leaks; DEL corrections repair any commit that turns out premature.
export function computeTerminalLiveMirrorStep(
  sentText: string,
  fieldText: string,
  options: { readonly commitHeld: boolean }
): TerminalLiveMirrorStep {
  const fieldCodePoints = Array.from(fieldText)
  const held = options.commitHeld ? NO_HELD_RUN : measureHeldRun(fieldCodePoints)
  const heldText = held.count > 0 ? fieldCodePoints.slice(-held.count).join('') : ''
  const targetCodePoints = held.count > 0 ? fieldCodePoints.slice(0, -held.count) : fieldCodePoints
  const sentCodePoints = Array.from(sentText)

  let commonPrefixLength = 0
  while (
    commonPrefixLength < sentCodePoints.length &&
    commonPrefixLength < targetCodePoints.length &&
    sentCodePoints[commonPrefixLength] === targetCodePoints[commonPrefixLength]
  ) {
    commonPrefixLength += 1
  }

  return {
    eraseCount: sentCodePoints.length - commonPrefixLength,
    appendText: targetCodePoints.slice(commonPrefixLength).join(''),
    nextSentText: targetCodePoints.join(''),
    heldText,
    heldCommitsOnPause: held.commitsOnPause
  }
}

export function buildTerminalLiveMirrorPayload(step: TerminalLiveMirrorStep): string {
  return TERMINAL_DEL_BYTE.repeat(step.eraseCount) + step.appendText
}
