import { getTerminalLiveSpecialKeyBytes } from './terminal-live-input'

// Why: React Native does not expose portable composition events here, so probable
// IME text gets a short settle window before being sent to the PTY.
export const TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS = 150

const TERMINAL_LIVE_ACCESSORY_LOCAL_EDIT_BYTES: ReadonlySet<string> = new Set([
  '\x7f',
  '\b',
  '\x1b[3~'
])

export type TerminalLiveTextChangeDecision =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'send-now'; readonly text: string }
  | { readonly kind: 'defer'; readonly text: string; readonly delayMs: number }

export type TerminalLiveSpecialKeyDecision =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'local-edit' }
  | { readonly kind: 'send-now'; readonly bytes: string }
  | { readonly kind: 'flush-then-send'; readonly pendingText: string; readonly bytes: string }

export type TerminalLiveSpecialKeyDecisionInput = {
  readonly key: string
  readonly pendingText: string
}

export type TerminalLiveAccessoryBytesDecisionInput = {
  readonly bytes: string
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

export function getTerminalLiveTextChangeDecision(text: string): TerminalLiveTextChangeDecision {
  if (text.length === 0) {
    return { kind: 'ignore' }
  }

  if (isTerminalLiveTextImeCandidate(text)) {
    return { kind: 'defer', text, delayMs: TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS }
  }

  return { kind: 'send-now', text }
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
  pendingText
}: TerminalLiveAccessoryBytesDecisionInput): TerminalLiveSpecialKeyDecision {
  if (pendingText.length > 0 && TERMINAL_LIVE_ACCESSORY_LOCAL_EDIT_BYTES.has(bytes)) {
    return { kind: 'local-edit' }
  }

  if (pendingText.length > 0) {
    return { kind: 'flush-then-send', pendingText, bytes }
  }

  return { kind: 'send-now', bytes }
}

export function getTerminalLiveAccessoryLocalEditText({
  bytes,
  pendingText
}: TerminalLiveAccessoryBytesDecisionInput): string {
  if (bytes !== '\x7f' && bytes !== '\b') {
    return pendingText
  }

  return Array.from(pendingText).slice(0, -1).join('')
}

export function getTerminalLiveSubmitSequence(pendingText: string): readonly string[] {
  if (pendingText.length === 0) {
    return ['\r']
  }

  return [pendingText, '\r']
}
