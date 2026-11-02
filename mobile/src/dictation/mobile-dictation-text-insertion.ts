import type { TextInputSelectionChangeEvent } from 'react-native'
import { dictationJoinsWithoutSpace } from '../../../src/shared/dictation-transcript-spacing'

// A field's selection, valid only while the field still holds the text it was read from.
export type MobileDictationAnchor = {
  readonly start: number
  readonly end: number
  readonly text: string
}

// The words heard so far and where the field will put them.
export type MobileDictationPreview = { anchor: MobileDictationAnchor | null; text: string }

export function readMobileDictationAnchor(
  event: TextInputSelectionChangeEvent,
  value: string
): MobileDictationAnchor {
  const { selection } = event.nativeEvent
  // The page's event carries the field's text; native events only have the selection.
  const text = 'text' in event.nativeEvent ? event.nativeEvent.text : undefined
  return { ...selection, text: typeof text === 'string' ? text : value }
}

const STRAIGHT_QUOTE_RE = /["'`]/
// A straight quote opens after a space or the start, and closes before a space, punctuation or the end; anything else is an apostrophe.
const opensQuote = (before: string): boolean => /(^|[\s([{])["'`]$/.test(before)
const closesQuote = (after: string): boolean => /^["'`]([^\p{L}\p{N}]|$)/u.test(after)

// Dictated text replaces the selection it started on, like typing; a draft changed since, or never focused, gets it at the end.
// It is spaced from its neighbours unless desktop's punctuation and CJK rules join them, or it sits just inside a quote.
export function splitDraftForDictation(
  draft: string,
  text: string,
  anchor: MobileDictationAnchor | null
): { before: string; after: string } {
  const placed = anchor?.text === draft ? anchor : null
  const start = Math.min(placed?.start ?? draft.length, draft.length)
  const end = Math.max(start, Math.min(placed?.end ?? draft.length, draft.length))
  const before = draft.slice(0, start)
  const after = draft.slice(end)
  const opened = opensQuote(before)
  const closed = closesQuote(after) && STRAIGHT_QUOTE_RE.test(before)
  return {
    before: opened || dictationJoinsWithoutSpace(before, text) ? before : `${before} `,
    after: closed || dictationJoinsWithoutSpace(text, after) ? after : ` ${after}`
  }
}

export function insertDictationText(
  draft: string,
  text: string,
  anchor: MobileDictationAnchor | null
): { text: string; caret: number } {
  const { before, after } = splitDraftForDictation(draft, text, anchor)
  return {
    text: `${before}${text}${after}`,
    caret: before.length + text.length
  }
}
