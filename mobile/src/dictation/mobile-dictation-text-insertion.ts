import type { TextInputSelectionChangeEvent } from 'react-native'
import { dictationSeparators } from '../../../src/shared/dictation-transcript-spacing'

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

// Dictated text replaces the selection it started on, like typing; a draft changed since, or never focused, gets it at the end.
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
  const { leading, trailing } = dictationSeparators(before, text, after)
  return { before: `${before}${leading}`, after: `${trailing}${after}` }
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
