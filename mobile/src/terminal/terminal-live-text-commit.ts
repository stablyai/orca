import { getTerminalLiveSpecialKeyBytes } from './terminal-live-input'

// Why: React Native does not expose portable composition events here, so
// non-Hangul IME text gets a short settle window before being sent to the PTY.
export const TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS = 150

export type TerminalLiveTextChangeDecision =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'send-now'; readonly text: string }
  | { readonly kind: 'defer'; readonly text: string; readonly delayMs: number | null }

export type TerminalLiveSpecialKeyDecision =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'local-edit' }
  | { readonly kind: 'send-now'; readonly bytes: string }
  | { readonly kind: 'flush-then-send'; readonly pendingText: string; readonly bytes: string }

export type TerminalLiveSpecialKeyDecisionInput = {
  readonly key: string
  readonly pendingText: string
}

export type TerminalLiveAccessoryLocalEdit = 'backspace' | 'delete'

export type TerminalLiveAccessoryBytesDecision =
  | { readonly kind: 'local-edit'; readonly localEdit: TerminalLiveAccessoryLocalEdit }
  | { readonly kind: 'send-now'; readonly bytes: string }
  | { readonly kind: 'flush-then-send'; readonly pendingText: string; readonly bytes: string }

export type TerminalLiveAccessoryBytesDecisionInput = {
  readonly bytes: string
  readonly localEdit?: TerminalLiveAccessoryLocalEdit
  readonly pendingText: string
}

export function isTerminalLiveTextImeCandidate(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && codePoint > 0x7f) {
      return true
    }
  }
  return false
}

function isHangulCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af)
  )
}

export function isTerminalLiveTextHangulCandidate(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && isHangulCodePoint(codePoint)) {
      return true
    }
  }
  return false
}

export function getTerminalLiveTextChangeDecision(text: string): TerminalLiveTextChangeDecision {
  if (text.length === 0) {
    return { kind: 'ignore' }
  }

  if (isTerminalLiveTextHangulCandidate(text)) {
    return { kind: 'defer', text, delayMs: null }
  }

  if (isTerminalLiveTextImeCandidate(text)) {
    return { kind: 'defer', text, delayMs: TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS }
  }

  return { kind: 'send-now', text }
}

export function getTerminalLiveDeferredTextDelayMs(text: string): number | null {
  return isTerminalLiveTextHangulCandidate(text) ? null : TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS
}

export function getTerminalLiveSpecialKeyDecision({
  key,
  pendingText
}: TerminalLiveSpecialKeyDecisionInput): TerminalLiveSpecialKeyDecision {
  const bytes = getTerminalLiveSpecialKeyBytes(key)
  if (bytes === null) {
    return { kind: 'ignore' }
  }

  if (pendingText.length > 0 && (key === 'Backspace' || key === 'Delete')) {
    return { kind: 'local-edit' }
  }

  if (pendingText.length > 0) {
    return { kind: 'flush-then-send', pendingText, bytes }
  }

  return { kind: 'send-now', bytes }
}

export function getTerminalLiveAccessoryBytesDecision({
  bytes,
  localEdit,
  pendingText
}: TerminalLiveAccessoryBytesDecisionInput): TerminalLiveAccessoryBytesDecision {
  if (pendingText.length > 0 && localEdit) {
    return { kind: 'local-edit', localEdit }
  }

  if (pendingText.length > 0) {
    return { kind: 'flush-then-send', pendingText, bytes }
  }

  return { kind: 'send-now', bytes }
}

export function getTerminalLiveAccessoryLocalEditText({
  localEdit,
  pendingText
}: {
  readonly localEdit: TerminalLiveAccessoryLocalEdit
  readonly pendingText: string
}): string {
  if (localEdit === 'delete') {
    // Why: accessory Delete mirrors forward-delete at the hidden input's end;
    // it stays local but does not remove the pending IME text.
    return pendingText
  }

  return Array.from(pendingText).slice(0, -1).join('')
}

export type TerminalLiveSubmitSequence = readonly ['\r'] | readonly [string, '\r']

export function getTerminalLiveSubmitSequence(pendingText: string): TerminalLiveSubmitSequence {
  if (pendingText.length === 0) {
    return ['\r']
  }

  return [pendingText, '\r']
}
