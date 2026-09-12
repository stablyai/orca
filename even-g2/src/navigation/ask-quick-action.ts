// Unit 5: ask quick-action send semantics (spec S7) — option digit -> "<n>\r", enter -> "\r",
// escape -> "\x1b" — plus the option-strip cursor math shared by the reducer and ask-screen.
import type { AskQuickAction } from './nav-contract'

const MAX_DIGIT_OPTIONS = 4 // AskQuickAction.digit is 1|2|3|4

/** Exact key sequence terminal.send receives for a quick action. */
export function askQuickActionToKeys(action: AskQuickAction): string {
  switch (action.kind) {
    case 'option':
      return `${action.digit}\r`
    case 'enter':
      return '\r'
    case 'escape':
      return '\x1b'
  }
}

/** Digit slots shown before Enter/Esc in the option strip, clamped to the digit type's range. */
export function askDigitCount(optionCount: number): number {
  return Math.min(Math.max(optionCount, 0), MAX_DIGIT_OPTIONS)
}

/** Total cursor slots in the strip `1 2 3 ... Enter Esc`. */
export function askStripSlotCount(optionCount: number): number {
  return askDigitCount(optionCount) + 2
}

export function clampAskCursor(selectedOption: number, optionCount: number): number {
  const max = askStripSlotCount(optionCount) - 1
  return Math.min(Math.max(selectedOption, 0), max)
}

/** Maps a strip cursor position to the AskQuickAction it represents. */
export function resolveAskQuickAction(selectedOption: number, optionCount: number): AskQuickAction {
  const digitCount = askDigitCount(optionCount)
  if (selectedOption < digitCount) {
    return { kind: 'option', digit: (selectedOption + 1) as 1 | 2 | 3 | 4 }
  }
  if (selectedOption === digitCount) {
    return { kind: 'enter' }
  }
  return { kind: 'escape' }
}
