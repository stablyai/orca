import { getTerminalLiveSpecialKeyBytes } from './terminal-live-input'
import { readUtf8CodePointAt } from '../../../src/shared/utf8-byte-limits'
import {
  encodeModifyOtherKeysEnter,
  TERMINAL_KITTY_SHIFT_ENTER_INPUT
} from '../../../src/shared/terminal-modified-enter-encoding'

export type TerminalLiveSpecialKeyDecision =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'local-edit' }
  | { readonly kind: 'send-now'; readonly bytes: string }
  | { readonly kind: 'commit-held-then-send'; readonly bytes: string }

export type TerminalLiveSpecialKeyDecisionInput = {
  readonly key: string
  readonly heldText: string
  readonly sentText: string
  readonly caretAtFieldEnd?: boolean
}

export type TerminalLiveAccessoryLocalEdit = 'backspace' | 'delete'

export type TerminalLiveInputSelection = { readonly start: number; readonly end: number }

export type TerminalLiveAccessoryBytesDecision =
  | { readonly kind: 'local-edit'; readonly localEdit: TerminalLiveAccessoryLocalEdit }
  | { readonly kind: 'send-now'; readonly bytes: string }
  | { readonly kind: 'commit-held-then-send'; readonly bytes: string }

export type TerminalLiveAccessoryBytesDecisionInput = {
  readonly bytes: string
  readonly localEdit?: TerminalLiveAccessoryLocalEdit
  readonly heldText: string
  readonly sentText: string
}

const FIELD_LOCAL_KEYS = new Set(['Backspace', 'Delete', 'ArrowLeft', 'Home'])
// At the field end these still reach the PTY, where shells accept an autosuggestion.
const FIELD_FORWARD_KEYS = new Set(['ArrowRight', 'End'])

export function getTerminalLiveSpecialKeyDecision({
  key,
  heldText,
  sentText,
  caretAtFieldEnd = true
}: TerminalLiveSpecialKeyDecisionInput): TerminalLiveSpecialKeyDecision {
  const bytes = getTerminalLiveSpecialKeyBytes(key)
  if (bytes === null) {
    return { kind: 'ignore' }
  }

  // The field edits and moves its own caret and the mirror diff keeps the PTY cursor at its end;
  // raw bytes here would erase twice or move the PTY cursor away from the mirror.
  if (
    (heldText.length > 0 || sentText.length > 0) &&
    (FIELD_LOCAL_KEYS.has(key) || (FIELD_FORWARD_KEYS.has(key) && !caretAtFieldEnd))
  ) {
    return { kind: 'local-edit' }
  }

  if (heldText.length > 0) {
    return { kind: 'commit-held-then-send', bytes }
  }

  return { kind: 'send-now', bytes }
}

// An ending Return or Shift+Enter gives echoed text to the terminal and resets the field mirror.
// Use endsWith because custom keys can contain command plus Return; an internal Return does not end this payload.
export function terminalLiveAccessoryInputEndsLine(bytes: string): boolean {
  return (
    bytes.endsWith('\r') ||
    bytes === TERMINAL_KITTY_SHIFT_ENTER_INPUT ||
    bytes === encodeModifyOtherKeysEnter(1, 2)
  )
}

export function getTerminalLiveAccessoryBytesDecision({
  bytes,
  localEdit,
  heldText,
  sentText
}: TerminalLiveAccessoryBytesDecisionInput): TerminalLiveAccessoryBytesDecision {
  if (localEdit && (heldText.length > 0 || sentText.length > 0)) {
    return { kind: 'local-edit', localEdit }
  }

  if (heldText.length > 0) {
    return { kind: 'commit-held-then-send', bytes }
  }

  return { kind: 'send-now', bytes }
}

/** Uses native UTF-16 selection offsets; collapsed deletion preserves adjacent surrogate pairs. */
export function getTerminalLiveAccessoryLocalEditText({
  localEdit,
  fieldText,
  selection
}: {
  readonly localEdit: TerminalLiveAccessoryLocalEdit
  readonly fieldText: string
  readonly selection?: TerminalLiveInputSelection | null
}): string {
  const start = Math.max(0, Math.min(selection?.start ?? fieldText.length, fieldText.length))
  const end = Math.max(start, Math.min(selection?.end ?? start, fieldText.length))
  if (start !== end) {
    return fieldText.slice(0, start) + fieldText.slice(end)
  }
  if (localEdit === 'delete') {
    const width = readUtf8CodePointAt(fieldText, start) > 0xffff ? 2 : 1
    return fieldText.slice(0, start) + fieldText.slice(start + width)
  }
  const width = start > 1 && readUtf8CodePointAt(fieldText, start - 2) > 0xffff ? 2 : 1
  return fieldText.slice(0, Math.max(0, start - width)) + fieldText.slice(start)
}
