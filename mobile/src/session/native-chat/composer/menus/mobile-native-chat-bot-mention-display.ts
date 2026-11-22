// The draft keeps each picked bot as the token the host reads; the plain-text field shows it as
// `@Name` and edits it as one unit, as the desktop's pill does.
import { useCallback, useMemo, useRef, useState } from 'react'
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

/** The field's side of `value`: what it shows, its caret, and its edits and selection in the
 *  draft's terms. */
export function useBotMentionField(value: string) {
  const display = useMemo(() => botMentionDisplay(value), [value])
  const [cursor, setCursor] = useState(0)
  // Drives the caret only right after an insert; a permanently controlled `selection` breaks
  // manual caret placement in React Native.
  const [pending, setPending] = useState<Selection | null>(null)
  // The field's last selection in the draft, which says where its next edit is.
  const selection = useRef<Selection>({ start: value.length, end: value.length })
  const place = useCallback((at: number) => {
    setCursor(at)
    setPending({ start: at, end: at })
    selection.current = { start: at, end: at }
  }, [])
  return {
    display,
    cursor,
    place,
    edit: (shown: string) => draftAfterFieldEdit(value, display, shown, selection.current),
    pendingSelection: pending && {
      start: shownOffset(display, pending.start),
      end: shownOffset(display, pending.end)
    },
    onSelectionChange: (shown: Selection): void => {
      selection.current = {
        start: draftOffset(display, shown.start),
        end: draftOffset(display, shown.end)
      }
      setCursor(selection.current.end)
      setPending(null)
    },
    resetCursor: () => setCursor(0),
    /** The field's selection as a place in the draft, for dictation. */
    anchor: (event: TextInputSelectionChangeEvent): MobileDictationAnchor =>
      draftAnchor(display, value, readMobileDictationAnchor(event, display.text))
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

/** The draft after the field's text became `shown`, from the selection it had (draft offsets);
 *  `caret` is set when the field's own caret would be wrong, as the draft shows other than typed. */
export function draftAfterFieldEdit(
  source: string,
  display: BotMentionDisplay,
  shown: string,
  selection: Selection
): { draft: string; caret: number | null } {
  if (display.spans.length === 0) {
    return { draft: shown, caret: null }
  }
  const edit = draftAfterShownEdit(source, display, shown, {
    start: shownOffset(display, selection.start),
    end: shownOffset(display, selection.end)
  })
  return botMentionDisplay(edit.draft).text === shown ? { ...edit, caret: null } : edit
}

/** Which part of `prev` became which part of `next`: what the selection says when the texts agree
 *  with it (typing, a backspace, a forward delete), else the shortest difference. */
function editedRange(prev: string, next: string, { start, end }: Selection) {
  const grew = next.length - prev.length
  const tail = (to: number) => next.length - (prev.length - to)
  const fits = ([from, to]: readonly [number, number]) =>
    from >= 0 &&
    from <= to &&
    to <= prev.length &&
    tail(to) >= from &&
    prev.slice(0, from) === next.slice(0, from) &&
    prev.slice(to) === next.slice(tail(to))
  const said: (readonly [number, number])[] =
    start !== end
      ? [[start, end]]
      : grew > 0
        ? [[start, start]]
        : [
            [start + grew, start],
            [start, start - grew]
          ]
  const found = said.find(fits)
  if (found) {
    return { from: found[0], to: found[1] }
  }
  const shortest = Math.min(prev.length, next.length)
  let from = 0
  while (from < shortest && prev[from] === next[from]) {
    from += 1
  }
  let same = 0
  while (same < shortest - from && prev[prev.length - 1 - same] === next[next.length - 1 - same]) {
    same += 1
  }
  return { from, to: prev.length - same }
}

/** The draft after the field's text went from `display.text` to `next`: typing inside a token goes
 *  after it, and an edit over any of it removes it whole. */
export function draftAfterShownEdit(
  source: string,
  display: BotMentionDisplay,
  next: string,
  selection: Selection
): { draft: string; caret: number } {
  const prev = display.text
  let { from, to } = editedRange(prev, next, selection)
  const inserted = next.slice(from, next.length - (prev.length - to))
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
