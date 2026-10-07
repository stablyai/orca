const ESC = '\x1b'

/**
 * One control sequence of gesture input. A `click` is a button press or release and must reach the
 * program; `movement` is a wheel report, an arrow scroll or a drag motion, which the next one supersedes.
 */
export type TerminalGestureInputReport = {
  readonly bytes: string
  readonly kind: 'click' | 'movement'
  /** Set on wheel and arrow-scroll reports: equal for reports that scroll the same way in the same encoding, wherever the finger was. */
  readonly scrollDirection?: string
}
const MAX_TERMINAL_GESTURE_INPUT_LENGTH = 2048
const MAX_TERMINAL_GESTURE_INPUT_SEQUENCES = 32
// Buttons: 0 left press/release, 32 left-drag motion, 64/65 wheel.
const SGR_MOUSE_GESTURE_SEQUENCE_RE = new RegExp(
  `^${ESC}\\[<(0|32|64|65);([0-9]{1,4});([0-9]{1,4})([Mm])$`
)

function isDefaultMouseClick(bytes: string, offset: number): boolean {
  const button = bytes.charCodeAt(offset + 3)
  return bytes.startsWith(`${ESC}[M`, offset) && (button === 32 || button === 35)
}

function isSgrMouseClick(bytes: string, offset: number): boolean {
  return bytes.startsWith(`${ESC}[<0;`, offset)
}

function scrollDirectionOf(sequence: string): string | undefined {
  if (sequence.length === 3) {
    return sequence
  }
  if (sequence.startsWith(`${ESC}[<64;`) || sequence.startsWith(`${ESC}[<65;`)) {
    return sequence.slice(0, 5)
  }
  const button = sequence.charCodeAt(3)
  if (sequence.startsWith(`${ESC}[M`) && (button === 96 || button === 97)) {
    return sequence.slice(0, 4)
  }
  return undefined
}

function isDefaultMouseGestureSequence(bytes: string, offset: number): number | null {
  if (!bytes.startsWith(`${ESC}[M`, offset) || offset + 6 > bytes.length) {
    return null
  }
  const button = bytes.charCodeAt(offset + 3)
  const col = bytes.charCodeAt(offset + 4)
  const row = bytes.charCodeAt(offset + 5)
  // Buttons: 32 left press, 35 release, 64 left-drag motion, 96/97 wheel.
  if (
    (button === 32 || button === 35 || button === 64 || button === 96 || button === 97) &&
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

export function splitTerminalGestureInput(bytes: string): TerminalGestureInputReport[] | null {
  if (bytes.length === 0 || bytes.length > MAX_TERMINAL_GESTURE_INPUT_LENGTH) {
    return null
  }

  let offset = 0
  const reports: TerminalGestureInputReport[] = []
  while (offset < bytes.length) {
    const next =
      isArrowScrollSequence(bytes, offset) ??
      isSgrMouseGestureSequence(bytes, offset) ??
      isDefaultMouseGestureSequence(bytes, offset)

    if (next == null) {
      return null
    }
    if (reports.length === MAX_TERMINAL_GESTURE_INPUT_SEQUENCES) {
      return null
    }
    const sequence = bytes.slice(offset, next)
    const scrollDirection = scrollDirectionOf(sequence)
    reports.push({
      bytes: sequence,
      kind:
        isSgrMouseClick(bytes, offset) || isDefaultMouseClick(bytes, offset) ? 'click' : 'movement',
      ...(scrollDirection ? { scrollDirection } : {})
    })
    offset = next
  }
  return reports
}

export function countTerminalGestureInputSequences(bytes: string): number | null {
  return splitTerminalGestureInput(bytes)?.length ?? null
}

export function isTerminalGestureInput(bytes: string): boolean {
  return countTerminalGestureInputSequences(bytes) != null
}
