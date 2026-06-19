const ESC = '\x1b'
const MAX_TERMINAL_GESTURE_INPUT_LENGTH = 2048
const MAX_TERMINAL_GESTURE_INPUT_SEQUENCES = 32
const SGR_MOUSE_GESTURE_SEQUENCE_RE = new RegExp(
  `^${ESC}\\[<(0|64|65);([0-9]{1,4});([0-9]{1,4})([Mm])$`
)

function isDefaultMouseGestureSequence(bytes: string, offset: number): number | null {
  if (!bytes.startsWith(`${ESC}[M`, offset) || offset + 6 > bytes.length) {
    return null
  }
  const button = bytes.charCodeAt(offset + 3)
  const col = bytes.charCodeAt(offset + 4)
  const row = bytes.charCodeAt(offset + 5)
  if (
    (button === 32 || button === 35 || button === 96 || button === 97) &&
    col >= 33 &&
    col <= 126 &&
    row >= 33 &&
    row <= 126
  ) {
    return offset + 6
  }
  return null
}

function isSgrMouseGestureSequence(bytes: string, offset: number): number | null {
  if (!bytes.startsWith(`${ESC}[<`, offset)) {
    return null
  }
  const pressEnd = bytes.indexOf('M', offset)
  const releaseEnd = bytes.indexOf('m', offset)
  const end =
    pressEnd === -1 ? releaseEnd : releaseEnd === -1 ? pressEnd : Math.min(pressEnd, releaseEnd)
  if (end === -1) {
    return null
  }
  const sequence = bytes.slice(offset, end + 1)
  const match = SGR_MOUSE_GESTURE_SEQUENCE_RE.exec(sequence)
  if (!match) {
    return null
  }
  const button = match[1]
  const col = Number(match[2])
  const row = Number(match[3])
  const final = match[4]
  if (button === '0') {
    return col >= 0 && row >= 0 ? end + 1 : null
  }
  return final === 'M' ? end + 1 : null
}

function isArrowScrollSequence(bytes: string, offset: number): number | null {
  const sequence = bytes.slice(offset, offset + 3)
  if (
    sequence === `${ESC}[A` ||
    sequence === `${ESC}[B` ||
    sequence === `${ESC}OA` ||
    sequence === `${ESC}OB`
  ) {
    return offset + 3
  }
  return null
}

export function countTerminalGestureInputSequences(bytes: string): number | null {
  if (bytes.length === 0 || bytes.length > MAX_TERMINAL_GESTURE_INPUT_LENGTH) {
    return null
  }

  let offset = 0
  let sequenceCount = 0
  while (offset < bytes.length) {
    const next =
      isArrowScrollSequence(bytes, offset) ??
      isSgrMouseGestureSequence(bytes, offset) ??
      isDefaultMouseGestureSequence(bytes, offset)

    if (next == null) {
      return null
    }
    sequenceCount += 1
    if (sequenceCount > MAX_TERMINAL_GESTURE_INPUT_SEQUENCES) {
      return null
    }
    offset = next
  }
  return sequenceCount
}

export function isTerminalGestureInput(bytes: string): boolean {
  return countTerminalGestureInputSequences(bytes) != null
}
