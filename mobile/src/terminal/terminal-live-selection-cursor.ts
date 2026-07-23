import {
  buildTerminalLiveMirrorPayload,
  computeTerminalLiveMirrorStep
} from './terminal-live-hangul-mirror'
import { getTerminalLiveSpecialKeyBytes } from './terminal-live-input'

const ARROW_LEFT = getTerminalLiveSpecialKeyBytes('ArrowLeft') ?? '\x1b[D'
const ARROW_RIGHT = getTerminalLiveSpecialKeyBytes('ArrowRight') ?? '\x1b[C'

export type TerminalLiveNativeSelection = {
  readonly start: number
  readonly end: number
}

export type TerminalLiveSelectionCursorState = {
  readonly sentText: string
  readonly heldText: string
  /** Code-point index of the PTY cursor within sentText (held text is not on the PTY). */
  readonly ptyCursorCodePoint: number
  /** Last normalized field text the mirror applied. */
  readonly fieldText: string
}

export type TerminalLiveSelectionCursorPlan = {
  readonly payload: string
  readonly nextSentText: string
  readonly heldText: string
  readonly nextPtyCursorCodePoint: number
  readonly nextFieldText: string
}

export function clampUtf16OffsetToCodePointBoundary(text: string, offset: number): number {
  if (offset <= 0) {
    return 0
  }
  if (offset >= text.length) {
    return text.length
  }
  // Why: native selection is UTF-16; never leave the offset between a surrogate pair.
  const codeUnit = text.charCodeAt(offset)
  if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
    return offset - 1
  }
  return offset
}

export function utf16OffsetToCodePointIndex(text: string, utf16Offset: number): number {
  const safeOffset = clampUtf16OffsetToCodePointBoundary(text, utf16Offset)
  let index = 0
  let unit = 0
  while (unit < safeOffset) {
    const codePoint = text.codePointAt(unit)
    if (codePoint === undefined) {
      break
    }
    unit += codePoint > 0xffff ? 2 : 1
    index += 1
  }
  return index
}

export function codePointIndexToUtf16Offset(text: string, codePointIndex: number): number {
  if (codePointIndex <= 0) {
    return 0
  }
  let index = 0
  let unit = 0
  while (unit < text.length && index < codePointIndex) {
    const codePoint = text.codePointAt(unit)
    if (codePoint === undefined) {
      break
    }
    unit += codePoint > 0xffff ? 2 : 1
    index += 1
  }
  return unit
}

// Normalize only the caret prefix so smart-punctuation expansion stays aligned
// with the bytes already mirrored to the PTY.
export function nativeSelectionToNormalizedCodePointIndex(
  rawFieldText: string,
  utf16Offset: number,
  normalize: (text: string) => string
): number {
  const safeOffset = clampUtf16OffsetToCodePointBoundary(rawFieldText, utf16Offset)
  const rawPrefix = rawFieldText.slice(0, safeOffset)
  return Array.from(normalize(rawPrefix)).length
}

function codePointLength(text: string): number {
  return Array.from(text).length
}

function buildArrowPayload(fromCodePoint: number, toCodePoint: number): string {
  if (toCodePoint === fromCodePoint) {
    return ''
  }
  if (toCodePoint > fromCodePoint) {
    return ARROW_RIGHT.repeat(toCodePoint - fromCodePoint)
  }
  return ARROW_LEFT.repeat(fromCodePoint - toCodePoint)
}

function clampCodePointIndex(index: number, maxInclusive: number): number {
  if (index < 0) {
    return 0
  }
  if (index > maxInclusive) {
    return maxInclusive
  }
  return index
}

// A terminal has one caret, so ranges wait for collapse; leaving a held Hangul
// suffix first commits it in the same payload before cursor arrows.
export function planTerminalLiveSelectionMove(
  state: TerminalLiveSelectionCursorState,
  selection: TerminalLiveNativeSelection,
  options: {
    readonly normalize: (text: string) => string
    readonly rawFieldText: string
  }
): TerminalLiveSelectionCursorPlan | null {
  // Why: multi-unit ranges have no single terminal caret; wait for collapse.
  if (selection.start !== selection.end) {
    return null
  }

  let payload = ''
  let sentText = state.sentText
  let heldText = state.heldText
  let ptyCursor = clampCodePointIndex(state.ptyCursorCodePoint, codePointLength(sentText))
  const fieldText = state.fieldText
  const targetOnField = nativeSelectionToNormalizedCodePointIndex(
    options.rawFieldText,
    selection.start,
    options.normalize
  )
  const visualEnd = codePointLength(sentText + heldText)

  if (heldText.length > 0) {
    // Why: iOS fires end-of-field selection during composition; flushing here
    // would commit the held syllable and break Hangul correction.
    if (targetOnField >= visualEnd) {
      return null
    }
    payload += buildArrowPayload(ptyCursor, codePointLength(sentText))
    const flushStep = computeTerminalLiveMirrorStep(sentText, fieldText, { commitHeld: true })
    payload += buildTerminalLiveMirrorPayload(flushStep)
    sentText = flushStep.nextSentText
    heldText = flushStep.heldText
    ptyCursor = codePointLength(sentText)
  }

  const target = clampCodePointIndex(targetOnField, codePointLength(sentText))
  const arrows = buildArrowPayload(ptyCursor, target)
  payload += arrows
  if (payload.length === 0) {
    return null
  }

  return {
    payload,
    nextSentText: sentText,
    heldText,
    nextPtyCursorCodePoint: target,
    nextFieldText: fieldText
  }
}

// RN reports text before its paired selection, so infer the edit-span end for
// the first payload and let the later selection event correct any mismatch.
export function inferTerminalLiveCaretCodePointAfterEdit(
  previousFieldText: string,
  nextFieldText: string
): number {
  const prev = Array.from(previousFieldText)
  const next = Array.from(nextFieldText)
  let prefix = 0
  while (prefix < prev.length && prefix < next.length && prev[prefix] === next[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < prev.length - prefix &&
    suffix < next.length - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return next.length - suffix
}

// Restore, suffix-rewrite, and reseat in one payload so a middle edit cannot
// interleave its cursor moves with another terminal send.
export function planTerminalLiveFieldTextChange(
  state: TerminalLiveSelectionCursorState,
  nextRawFieldText: string,
  nextSelection: TerminalLiveNativeSelection | null,
  options: {
    readonly normalize: (text: string) => string
    readonly commitHeld: boolean
  }
): TerminalLiveSelectionCursorPlan {
  const nextFieldText = options.normalize(nextRawFieldText)
  let payload = ''
  const sentText = state.sentText
  let ptyCursor = clampCodePointIndex(state.ptyCursorCodePoint, codePointLength(sentText))

  payload += buildArrowPayload(ptyCursor, codePointLength(sentText))

  const step = computeTerminalLiveMirrorStep(sentText, nextFieldText, {
    commitHeld: options.commitHeld
  })
  payload += buildTerminalLiveMirrorPayload(step)
  const nextSentText = step.nextSentText
  const heldText = step.heldText
  ptyCursor = codePointLength(nextSentText)

  const sentLen = ptyCursor
  let target: number
  if (nextSelection && nextSelection.start === nextSelection.end) {
    target = clampCodePointIndex(
      nativeSelectionToNormalizedCodePointIndex(
        nextRawFieldText,
        nextSelection.start,
        options.normalize
      ),
      // Why: held syllables are not on the PTY yet; the caret cannot enter them.
      sentLen
    )
  } else if (nextSelection && nextSelection.start !== nextSelection.end) {
    // Non-collapsed: leave the PTY caret at the mirrored end until collapse.
    target = sentLen
  } else {
    // No selection yet: infer from the field diff so mid-insert/delete batch.
    const previousField = state.fieldText.length > 0 ? state.fieldText : sentText + state.heldText
    target = clampCodePointIndex(
      inferTerminalLiveCaretCodePointAfterEdit(previousField, nextFieldText),
      sentLen
    )
  }

  payload += buildArrowPayload(ptyCursor, target)

  return {
    payload,
    nextSentText,
    heldText,
    nextPtyCursorCodePoint: target,
    nextFieldText
  }
}
