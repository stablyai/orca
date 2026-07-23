// Why: paused text should still reach the PTY quickly; DEL corrections converge
// a trailing syllable that changes after this short settle window.
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

export function isTerminalLiveJapaneseKanaCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0xff65 && codePoint <= 0xff9f) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b16f)
  )
}

function getTerminalLiveHeldSuffixLength(fieldCodePoints: readonly string[]): number {
  const lastCodePoint = fieldCodePoints.at(-1)?.codePointAt(0)
  if (lastCodePoint === undefined) {
    return 0
  }
  if (isTerminalLiveHangulCodePoint(lastCodePoint)) {
    return 1
  }
  if (!isTerminalLiveJapaneseKanaCodePoint(lastCodePoint)) {
    return 0
  }

  const isCombiningKanaModifier =
    lastCodePoint === 0x3099 ||
    lastCodePoint === 0x309a ||
    lastCodePoint === 0xff9e ||
    lastCodePoint === 0xff9f
  const precedingCodePoint = fieldCodePoints.at(-2)?.codePointAt(0)
  if (
    isCombiningKanaModifier &&
    precedingCodePoint !== undefined &&
    isTerminalLiveJapaneseKanaCodePoint(precedingCodePoint)
  ) {
    return 2
  }
  return 1
}

export type TerminalLiveMirrorStep = {
  readonly eraseCount: number
  readonly appendText: string
  readonly nextSentText: string
  readonly heldText: string
}

// Why: Japanese flick modifiers and Hangul composition can rewrite a trailing
// syllable; hold the mutable suffix through the normal modifier window.
export function computeTerminalLiveMirrorStep(
  sentText: string,
  fieldText: string,
  options: { readonly commitHeld: boolean }
): TerminalLiveMirrorStep {
  const fieldCodePoints = Array.from(fieldText)
  const heldSuffixLength = options.commitHeld ? 0 : getTerminalLiveHeldSuffixLength(fieldCodePoints)
  const heldText = heldSuffixLength > 0 ? fieldCodePoints.slice(-heldSuffixLength).join('') : ''
  const targetCodePoints =
    heldSuffixLength > 0 ? fieldCodePoints.slice(0, -heldSuffixLength) : fieldCodePoints
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
