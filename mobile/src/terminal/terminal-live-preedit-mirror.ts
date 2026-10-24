// Why: an unreported preedit that pauses should still reach the PTY quickly;
// corrections make a premature commit safe. Only armed when the platform
// reports nothing — a reported preedit is not text yet and must never time out.
export const TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS = 300

const TERMINAL_DEL_BYTE = '\x7f'
const LAST_ASCII_CODE_POINT = 0x7f

export type TerminalLiveMirrorStep = {
  readonly eraseCount: number
  readonly appendText: string
  readonly nextSentText: string
  readonly heldText: string
}

function isTerminalLiveConjoiningJamo(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
    (codePoint >= 0xd7b0 && codePoint <= 0xd7c6) ||
    (codePoint >= 0xd7cb && codePoint <= 0xd7fb)
  )
}

function heldTrailingConjoiningJamoLength(
  fieldCodePoints: readonly string[],
  stableLength: number
): number {
  let held = 0
  while (
    held < fieldCodePoints.length - stableLength &&
    isTerminalLiveConjoiningJamo(
      fieldCodePoints[fieldCodePoints.length - 1 - held]?.codePointAt(0) ?? 0
    )
  ) {
    held += 1
  }
  return held
}

// iOS 10-Key rewrites conjoining jamo without marked text; hold them to avoid editor-dependent DELs.
function heldPreeditLength(
  fieldCodePoints: readonly string[],
  stableLength: number,
  composing: boolean | undefined
): number {
  if (composing !== undefined) {
    return composing
      ? fieldCodePoints.length - stableLength
      : heldTrailingConjoiningJamoLength(fieldCodePoints, stableLength)
  }
  let held = 0
  while (
    held < fieldCodePoints.length &&
    (fieldCodePoints[fieldCodePoints.length - 1 - held]?.codePointAt(0) ?? 0) >
      LAST_ASCII_CODE_POINT
  ) {
    held += 1
  }
  // Why the bound: the run can reach back over code points already delivered to the pty, and
  // holding those makes the caller erase them with DEL and retype them. The reported branch above
  // subtracts `stableLength` for the same reason; without it a settle-timer commit followed by
  // another keystroke costs a DEL per already-sent character.
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
