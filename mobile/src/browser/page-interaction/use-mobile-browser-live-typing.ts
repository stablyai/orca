import { useCallback, useEffect, useRef, useState } from 'react'
import type { TextInputInstance, TextInputKeyPressEvent } from 'react-native'
import { reportedLiveInputComposing } from '../../platform/text-input/live-input-composing-range'
import { useTerminalTextFieldSubmitBinding } from '../../terminal/live-input/use-terminal-text-field-submit-binding'
import type { MobileBrowserPageInput, PageInputStep } from './use-mobile-browser-page-input-queue'

// Past this the hidden field starts over; Backspace on an empty field still reaches the page.
const MIRROR_RESET_LENGTH = 256

const graphemes =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

// Chromium's Backspace takes an emoji (with its modifiers, joiners and flags) whole, anything else one code point at a time.
const DELETED_WHOLE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u

function graphemeStarts(text: string): number[] {
  return graphemes ? Array.from(graphemes.segment(text), (part) => part.index) : []
}

function backspacesFor(deleted: string): number {
  if (!graphemes) {
    return Array.from(deleted).length
  }
  let count = 0
  for (const { segment } of graphemes.segment(deleted)) {
    count += DELETED_WHOLE.test(segment) ? 1 : Array.from(segment).length
  }
  return count
}

/** What the page must do to turn the field's old text into its new text: delete, then type. */
export function liveTypingSteps(previous: string, next: string): PageInputStep[] {
  let common = 0
  while (
    common < previous.length &&
    common < next.length &&
    previous.charCodeAt(common) === next.charCodeAt(common)
  ) {
    common += 1
  }
  // Edit whole characters: an emoji whose skin tone changed is deleted and typed again, never split.
  const starts = graphemeStarts(previous)
  if (starts.length > 0 && common < previous.length) {
    common = starts.findLast((start) => start <= common) ?? 0
  } else if (common > 0 && isHighSurrogate(previous.charCodeAt(common - 1))) {
    common -= 1
  }
  const steps: PageInputStep[] = Array.from(
    { length: backspacesFor(previous.slice(common)) },
    () => ({ key: 'Backspace' })
  )
  const typed = next.slice(common)
  if (typed) {
    steps.push({ text: typed })
  }
  return steps
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

type LiveTypingArgs = {
  disabled: boolean
  pageInput: MobileBrowserPageInput
}

type LiveTypingChange = { nativeEvent: { text: string; isComposing?: boolean } }

/** A hidden field that types straight into the page: every change is sent as it happens. */
export function useMobileBrowserLiveTyping({ disabled, pageInput }: LiveTypingArgs) {
  const inputRef = useRef<TextInputInstance | null>(null)
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  // What the page's field has been sent of the hidden field's text.
  const sentRef = useRef('')

  const resetMirror = useCallback(() => {
    sentRef.current = ''
    setValue('')
  }, [])
  // A tap or navigation may move the page to another field, which holds none of what was typed.
  useEffect(() => pageInput.onFocusMove(resetMirror), [pageInput, resetMirror])

  const send = useCallback(
    (steps: PageInputStep[]) => {
      if (steps.length === 0) {
        return
      }
      void pageInput.queue(steps).then((delivered) => {
        // The field no longer matches the page; stop so a later Backspace can't delete what was there before.
        if (!delivered) {
          resetMirror()
          inputRef.current?.blur()
        }
      })
    },
    [pageInput, resetMirror]
  )

  const apply = useCallback(
    (next: string, composing: boolean) => {
      setValue(next)
      // An IME's word goes to the page once picked, not letter by letter.
      if (composing) {
        return
      }
      send(liveTypingSteps(sentRef.current, next))
      if (next.length > MIRROR_RESET_LENGTH) {
        resetMirror()
        return
      }
      sentRef.current = next
    },
    [resetMirror, send]
  )

  const onChange = useCallback(
    ({ nativeEvent }: LiveTypingChange) =>
      apply(nativeEvent.text, reportedLiveInputComposing(nativeEvent.isComposing) === true),
    [apply]
  )

  // An empty field has nothing for Backspace to change, so the key itself goes to the page.
  const onKeyPress = useCallback(
    (event: TextInputKeyPressEvent) => {
      if (event.nativeEvent.key === 'Backspace' && sentRef.current === '') {
        send([{ key: 'Backspace' }])
      }
    },
    [send]
  )

  const onSubmitEditing = useCallback(() => {
    send([{ key: 'Enter' }])
    resetMirror()
  }, [resetMirror, send])

  // Android's composing Return skips onSubmitEditing, and a commit's last input still reports composing.
  const bindInput = useTerminalTextFieldSubmitBinding(
    inputRef,
    onSubmitEditing,
    undefined,
    (text) => apply(text, false)
  )

  /** A key from the row above the keyboard, sent after anything still being typed. */
  const pressKey = useCallback(
    (key: string) => {
      send([{ key }])
      // Tab and the arrows move the page's caret or focus away from what the field mirrors.
      resetMirror()
    },
    [resetMirror, send]
  )

  // Must run inside the tap: iOS raises the keyboard only for a focus the gesture made.
  const focus = useCallback(() => {
    if (!disabled) {
      inputRef.current?.focus()
    }
  }, [disabled])
  const blur = useCallback(() => inputRef.current?.blur(), [])

  const onFocus = useCallback(() => {
    resetMirror()
    setFocused(true)
  }, [resetMirror])
  const onBlur = useCallback(() => {
    setFocused(false)
    resetMirror()
  }, [resetMirror])

  return {
    inputProps: { ref: bindInput, value, onChange, onKeyPress, onSubmitEditing, onFocus, onBlur },
    focused,
    focus,
    blur,
    pressKey
  }
}
