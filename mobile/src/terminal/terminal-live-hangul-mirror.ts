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

export type TerminalLiveMirrorStep = {
  readonly eraseCount: number
  readonly appendText: string
  readonly nextSentText: string
  readonly heldText: string
}

// Why: React Native exposes no composition events, but Hangul composition only
// mutates the trailing syllable. Holding just that code point keeps the PTY
// echo live while preedit jamo never leak; DEL corrections repair any commit
// that later turns out to be premature.
export function computeTerminalLiveMirrorStep(
  sentText: string,
  fieldText: string,
  options: { readonly commitHeld: boolean }
): TerminalLiveMirrorStep {
  const fieldCodePoints = Array.from(fieldText)
  const lastCodePoint = fieldCodePoints.at(-1)
  const holdLast =
    !options.commitHeld &&
    lastCodePoint !== undefined &&
    isTerminalLiveHangulCodePoint(lastCodePoint.codePointAt(0) ?? 0)
  const heldText = holdLast && lastCodePoint !== undefined ? lastCodePoint : ''
  const targetCodePoints = holdLast ? fieldCodePoints.slice(0, -1) : fieldCodePoints
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
    heldText
  }
}

export function buildTerminalLiveMirrorPayload(step: TerminalLiveMirrorStep): string {
  return TERMINAL_DEL_BYTE.repeat(step.eraseCount) + step.appendText
}
