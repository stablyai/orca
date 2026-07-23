// iOS reports text before its paired selection; only an unpaired selection is
// a trackpad-only move that may commit held Hangul.
export type TerminalLiveSelectionEventKind = 'paired-with-text-change' | 'cursor-only'

export function classifyTerminalLiveSelectionEvent(
  expectsPairedAfterTextChange: boolean
): TerminalLiveSelectionEventKind {
  return expectsPairedAfterTextChange ? 'paired-with-text-change' : 'cursor-only'
}

// A paired selection may correct an inferred ASCII caret, but must not flush
// Hangul preedit that the preceding text event intentionally held.
export function shouldApplyTerminalLiveCursorOnlySelectionMove(options: {
  readonly kind: TerminalLiveSelectionEventKind
  readonly heldText: string
  readonly allowSoftReseatWhenPaired: boolean
}): boolean {
  if (options.kind === 'cursor-only') {
    return true
  }
  if (options.heldText.length > 0) {
    return false
  }
  return options.allowSoftReseatWhenPaired
}

/** Physical arrows: selection owns PTY steps when the field has text. */
export function isTerminalLiveFieldOwnedArrowKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight'
}
