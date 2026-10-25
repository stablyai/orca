// Unreported preedit may settle on timeout and be corrected later; explicitly reported composition must never time out.
export const TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS = 300

const TERMINAL_DEL_BYTE = '\x7f'
const LAST_ASCII_CODE_POINT = 0x7f

export type TerminalLiveMirrorStep = {
  readonly eraseCount: number
  readonly appendText: string
  readonly nextSentText: string
  readonly heldText: string
}

// Reported marked-text ranges define preedit, including ASCII; never infer reported composition from script.
// Platforms without ranges hold trailing non-ASCII runs, preserving immediate ASCII echo but unable to detect ASCII preedit.
function heldPreeditLength(
  fieldCodePoints: readonly string[],
  stableLength: number,
  composing: boolean | undefined
): number {
  if (composing !== undefined) {
    return composing ? fieldCodePoints.length - stableLength : 0
  }
  let held = 0
  while (
    held < fieldCodePoints.length &&
    (fieldCodePoints[fieldCodePoints.length - 1 - held]?.codePointAt(0) ?? 0) >
      LAST_ASCII_CODE_POINT
  ) {
    held += 1
  }
  // Bound holds by stableLength so later keystrokes cannot erase and retype text already delivered by a settle commit.
  return Math.min(held, fieldCodePoints.length - stableLength)
}

function commonPrefixLength(left: readonly string[], right: readonly string[]): number {
  let length = 0
  while (length < left.length && length < right.length && left[length] === right[length]) {
    length += 1
  }
  return length
}

export function computeTerminalLiveMirrorStep(
  sentText: string,
  fieldText: string,
  options: { readonly commitHeld: boolean; readonly composing?: boolean }
): TerminalLiveMirrorStep {
  const fieldCodePoints = Array.from(fieldText)
  const sentCodePoints = Array.from(sentText)
  const stableLength = commonPrefixLength(sentCodePoints, fieldCodePoints)
  const heldLength = options.commitHeld
    ? 0
    : heldPreeditLength(fieldCodePoints, stableLength, options.composing)
  const targetCodePoints = fieldCodePoints.slice(0, fieldCodePoints.length - heldLength)
  const keptLength = Math.min(stableLength, targetCodePoints.length)

  return {
    eraseCount: sentCodePoints.length - keptLength,
    appendText: targetCodePoints.slice(keptLength).join(''),
    nextSentText: targetCodePoints.join(''),
    heldText: fieldCodePoints.slice(fieldCodePoints.length - heldLength).join('')
  }
}

export function buildTerminalLiveMirrorPayload(step: TerminalLiveMirrorStep): string {
  return TERMINAL_DEL_BYTE.repeat(step.eraseCount) + step.appendText
}
