import { getTerminalLiveSpecialKeyBytes } from './terminal-live-input'

const TERMINAL_DEL_BYTE = '\x7f'

export type TerminalLiveReplacement = {
  readonly text: string
  readonly replacementText: string
  readonly replacementRange: {
    readonly start: number
    readonly end: number
  }
}

export type TerminalLiveCommit = {
  readonly committedText: string
  readonly payload: string
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) {
    return false
  }
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

export function deriveTerminalLiveCommit(
  committedText: string,
  change: TerminalLiveReplacement
): TerminalLiveCommit | null {
  const { start, end } = change.replacementRange
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start > committedText.length ||
    end < committedText.length ||
    end < start ||
    splitsSurrogatePair(committedText, start)
  ) {
    return null
  }
  if (change.text === committedText) {
    return { committedText, payload: '' }
  }

  const retainedText = committedText.slice(0, start)
  const predictedText = retainedText + change.replacementText
  const operationMatchesText = change.text === predictedText
  const replacementStart = operationMatchesText ? start : 0

  const eraseCount = Array.from(committedText.slice(replacementStart)).length
  return {
    committedText: change.text,
    payload: TERMINAL_DEL_BYTE.repeat(eraseCount) + change.text.slice(replacementStart)
  }
}

export function getTerminalLiveSpecialKeyDecision(
  key: string,
  hasCommittedText: boolean
): { readonly kind: 'ignore' } | { readonly kind: 'send'; readonly bytes: string } {
  const bytes = getTerminalLiveSpecialKeyBytes(key)
  if (bytes === null || ((key === 'Backspace' || key === 'Delete') && hasCommittedText)) {
    return { kind: 'ignore' }
  }
  return { kind: 'send', bytes }
}
