// The draft keeps each picked bot as the token the host reads; the plain-text field shows it as
// `@Name` and edits it as one unit, as the desktop's pill does.
import { useMemo, useRef } from 'react'
import {
  botMentionLabel,
  botMentionsAt
} from '../../../../../../src/shared/bots/bot-mention-context'
import type { TextInputSelectionChangeEvent } from 'react-native'
import {
  readMobileDictationAnchor,
  type MobileDictationAnchor
} from '../../../../dictation/mobile-dictation-text-insertion'

type Span = { start: number; end: number; shownStart: number; shownEnd: number }

export type BotMentionDisplay = { text: string; spans: readonly Span[] }

export function botMentionDisplay(source: string): BotMentionDisplay {
  const spans: Span[] = []
  let text = ''
  let at = 0
  for (const mention of botMentionsAt(source)) {
    text += source.slice(at, mention.start)
    const shown = botMentionLabel(mention)
    spans.push({
      start: mention.start,
      end: mention.end,
      shownStart: text.length,
      shownEnd: text.length + shown.length
    })
    text += shown
    at = mention.end
  }
  return { text: text + source.slice(at), spans }
}

/** A field offset in the draft; one inside a token lands after it. */
export function draftOffset(display: BotMentionDisplay, shown: number): number {
  let delta = 0
  for (const span of display.spans) {
    if (shown <= span.shownStart) {
      break
    }
    if (shown < span.shownEnd) {
      return span.end
    }
    delta = span.end - span.shownEnd
  }
  return shown + delta
}

/** A draft offset in the field; one inside a token lands after it. */
export function shownOffset(display: BotMentionDisplay, offset: number): number {
  let delta = 0
  for (const span of display.spans) {
    if (offset <= span.start) {
      break
    }
    if (offset < span.end) {
      return span.shownEnd
    }
    delta = span.shownEnd - span.end
  }
  return offset + delta
}

type Selection = { start: number; end: number }

/** The field's side of `value`: what it shows, and its edits and selection in the draft's terms. */
export function useBotMentionField(value: string) {
  const display = useMemo(() => botMentionDisplay(value), [value])
  // Where the last selection started, so an edit next to a picked bot lands on its side of it.
  const selectionStart = useRef(0)
  return {
    display,
    edit: (shown: string) => draftAfterFieldEdit(value, display, shown, selectionStart.current),
    /** Takes the field's selection; returns where its end is in the draft. */
    select: (selection: Selection): number => {
      selectionStart.current = draftOffset(display, selection.start)
      return draftOffset(display, selection.end)
    },
    /** The field's selection as a place in the draft, for dictation. */
    anchor: (event: TextInputSelectionChangeEvent): MobileDictationAnchor =>
      draftAnchor(display, value, readMobileDictationAnchor(event, display.text)),
    shown: (selection: Selection | null): Selection | null =>
      selection && {
        start: shownOffset(display, selection.start),
        end: shownOffset(display, selection.end)
      }
  }
}

// Another text's selection stays as it is: dictation then lands at the draft's end.
function draftAnchor(
  display: BotMentionDisplay,
  source: string,
  anchor: MobileDictationAnchor
): MobileDictationAnchor {
  return anchor.text === display.text
    ? {
        start: draftOffset(display, anchor.start),
        end: draftOffset(display, anchor.end),
        text: source
      }
    : anchor
}

/** Dictation's draft halves as the field shows them. */
export function shownDictationPreview<Preview extends { before: string; after: string }>(
  preview: Preview | null
): Preview | null {
  return (
    preview && {
      ...preview,
      before: botMentionDisplay(preview.before).text,
      after: botMentionDisplay(preview.after).text
    }
  )
}

/** The draft after the field's text became `shown`; `caret` is set when the field's own caret
 *  would be wrong because the draft shows other than what was typed. */
export function draftAfterFieldEdit(
  source: string,
  display: BotMentionDisplay,
  shown: string,
  selectionStart: number
): { draft: string; caret: number | null } {
  if (display.spans.length === 0) {
    return { draft: shown, caret: null }
  }
  const edit = draftAfterShownEdit(source, display, shown, shownOffset(display, selectionStart))
  return botMentionDisplay(edit.draft).text === shown ? { ...edit, caret: null } : edit
}

/** The draft after the field's text went from `display.text` to `next`, the edit starting no later
 *  than `caret`: typing inside a token goes after it, and an edit over any of it removes it whole. */
export function draftAfterShownEdit(
  source: string,
  display: BotMentionDisplay,
  next: string,
  caret: number
): { draft: string; caret: number } {
  const prev = display.text
  const shortest = Math.min(prev.length, next.length)
  let start = 0
  while (start < shortest && prev[start] === next[start]) {
    start += 1
  }
  start = Math.min(start, caret)
  let same = 0
  while (same < shortest - start && prev[prev.length - 1 - same] === next[next.length - 1 - same]) {
    same += 1
  }
  const inserted = next.slice(start, next.length - same)
  let from = start
  let to = prev.length - same
  for (const span of display.spans) {
    if (from === to) {
      if (span.shownStart < from && from < span.shownEnd) {
        from = to = span.shownEnd
      }
    } else if (span.shownStart < to && span.shownEnd > from) {
      from = Math.min(from, span.shownStart)
      to = Math.max(to, span.shownEnd)
    }
  }
  const head = source.slice(0, draftOffset(display, from)) + inserted
  return { draft: head + source.slice(draftOffset(display, to)), caret: head.length }
}
