/**
 * What one stretch of terminal output proves about a repaint.
 * `carry` is the trailing escape sequence cut off by the chunk boundary, kept for the next chunk.
 */
export type RepaintSignals = {
  /** A complete `CSI 2 J` outside any control string. */
  fullErase: boolean
  /** A complete DEC private-mode set/reset naming 47, 1047 or 1049, in any parameter position. */
  bufferToggle: boolean
  carry: string
}

const ESC = '\u001b'
const CSI = '\u009b'
const BUFFER_SWITCH_MODES = new Set(['47', '1047', '1049'])

/** Scan output for the only two signals that may retire a reflowed grid, ignoring control-string text. */
export function scanRepaintSignals(text: string): RepaintSignals {
  let fullErase = false
  let bufferToggle = false
  let index = 0
  while (index < text.length) {
    if (text[index] === ESC) {
      const parsed = parseEscape(text, index)
      if ('carry' in parsed) {
        return { fullErase, bufferToggle, carry: parsed.carry }
      }
      fullErase ||= parsed.fullErase
      bufferToggle ||= parsed.bufferToggle
      index = parsed.next
    } else if (text[index] === CSI) {
      const parsed = parseCsi(text, index + 1)
      if ('carry' in parsed) {
        return { fullErase, bufferToggle, carry: text.slice(index) }
      }
      fullErase ||= parsed.fullErase
      bufferToggle ||= parsed.bufferToggle
      index = parsed.next
    } else {
      index += 1
    }
  }
  return { fullErase, bufferToggle, carry: '' }
}

type ParsedEscape = { next: number; fullErase: boolean; bufferToggle: boolean } | { carry: string }

/** Parse from an ESC byte; a string or CSI without its terminator becomes the next chunk's carry. */
function parseEscape(text: string, start: number): ParsedEscape {
  if (start + 1 >= text.length) {
    return { carry: text.slice(start) }
  }
  const introducer = text[start + 1]
  if (introducer === '[') {
    const parsed = parseCsi(text, start + 2)
    return 'carry' in parsed ? { carry: text.slice(start) } : parsed
  }
  if (
    introducer === ']' ||
    introducer === 'P' ||
    introducer === 'X' ||
    introducer === '^' ||
    introducer === '_'
  ) {
    const end = findStringEnd(text, start + 2, introducer === ']')
    return end === -1
      ? { carry: text.slice(start) }
      : { next: end, fullErase: false, bufferToggle: false }
  }
  // Any other escape is complete once its second byte is here (for example ESC 7).
  return { next: start + 2, fullErase: false, bufferToggle: false }
}

/** Parse CSI parameters/intermediates from just after the introducer through its final byte. */
function parseCsi(
  text: string,
  start: number
): { next: number; fullErase: boolean; bufferToggle: boolean } | { carry: string } {
  let index = start
  while (index < text.length && text.charCodeAt(index) < 0x40) {
    index += 1
  }
  if (index >= text.length) {
    return { carry: text.slice(start) }
  }
  const parameters = text.slice(start, index)
  const final = text[index]
  const next = index + 1
  if (final === 'J' && parameters === '2') {
    return { next, fullErase: true, bufferToggle: false }
  }
  if ((final === 'h' || final === 'l') && parameters.startsWith('?')) {
    return { next, fullErase: false, bufferToggle: namesBufferSwitch(parameters.slice(1)) }
  }
  return { next, fullErase: false, bufferToggle: false }
}

function namesBufferSwitch(parameters: string): boolean {
  return parameters.split(';').some((parameter) => BUFFER_SWITCH_MODES.has(parameter.split(':')[0]))
}

/** Index just past BEL (OSC only) or ST, or -1 when the string is still open. */
function findStringEnd(text: string, start: number, allowBel: boolean): number {
  for (let index = start; index < text.length; index += 1) {
    if (allowBel && text[index] === '\u0007') {
      return index + 1
    }
    if (text[index] === ESC && text[index + 1] === '\\') {
      return index + 2
    }
  }
  return -1
}
