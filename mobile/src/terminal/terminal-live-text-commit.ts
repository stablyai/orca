import { getTerminalLiveSpecialKeyBytes } from './terminal-live-input'
import { readUtf8CodePointAt } from '../../../src/shared/utf8-byte-limits'

export type TerminalLiveSpecialKeyDecision =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'local-edit' }
  | { readonly kind: 'send-now'; readonly bytes: string }
  | { readonly kind: 'commit-held-then-send'; readonly bytes: string }

export type TerminalLiveSpecialKeyDecisionInput = {
  readonly key: string
  readonly heldText: string
  readonly sentText: string
}

export type TerminalLiveAccessoryLocalEdit = 'backspace' | 'delete'

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

export function getTerminalLiveSpecialKeyDecision({
  key,
  heldText,
  sentText
}: TerminalLiveSpecialKeyDecisionInput): TerminalLiveSpecialKeyDecision {
  const bytes = getTerminalLiveSpecialKeyBytes(key)
  if (bytes === null) {
    return { kind: 'ignore' }
  }

  // Why: native field edits fire onChangeText and the mirror diff emits the
  // matching PTY erase; sending raw DEL here as well would double-erase.
  if ((key === 'Backspace' || key === 'Delete') && (heldText.length > 0 || sentText.length > 0)) {
    return { kind: 'local-edit' }
  }

  if (heldText.length > 0) {
    return { kind: 'commit-held-then-send', bytes }
  }

  return { kind: 'send-now', bytes }
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

export function getTerminalLiveAccessoryLocalEditText({
  localEdit,
  fieldText
}: {
  readonly localEdit: TerminalLiveAccessoryLocalEdit
  readonly fieldText: string
}): string {
  if (localEdit === 'delete') {
    // Why: accessory Delete mirrors forward-delete at the hidden input's end;
    // it stays local but does not remove the field text.
    return fieldText
  }

  const end = fieldText.length
  const width = end > 1 && readUtf8CodePointAt(fieldText, end - 2) > 0xffff ? 2 : 1
  return fieldText.slice(0, -width)
}
