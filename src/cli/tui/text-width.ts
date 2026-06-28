/** Display-cell-aware text helpers. Chrome is plain text we pad/truncate by
 *  visible width; viewport lines carry SGR we must clip without splitting an
 *  escape. Implemented dependency-free: the CLI compiles to CommonJS and the
 *  popular libs (slice-ansi/string-width) are ESM-only, so we hand-roll the
 *  small amount we need and stay synchronous on the render path. */

const ESC = '\x1b'

/** Visible width of one code point: 0 for zero-width/combining marks, 2 for the
 *  common wide (CJK/fullwidth/emoji) ranges, else 1. Deliberately approximate —
 *  enough to keep columns aligned for terminal content. */
function charWidth(cp: number): number {
  if (cp === 0) {
    return 0
  }
  // C0/C1 controls and zero-width joiners/variation selectors.
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) {
    return 0
  }
  if (cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) {
    return 0
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & symbols
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extension B+
  ) {
    return 2
  }
  return 1
}

/** Length of the ANSI escape starting at `i` (CSI/OSC/other), or 0 if `line[i]`
 *  is not an escape. Used to pass escapes through clipping uncounted. */
function escapeLength(line: string, i: number): number {
  if (line[i] !== ESC || i + 1 >= line.length) {
    return 0
  }
  const next = line[i + 1]
  if (next === '[') {
    let j = i + 2
    // CSI: params/intermediates (0x20–0x3F) then one final byte (0x40–0x7E).
    while (j < line.length) {
      const code = line.charCodeAt(j)
      if (code >= 0x40 && code <= 0x7e) {
        return j - i + 1
      }
      j += 1
    }
    return j - i
  }
  // Other escapes (OSC, single-char) — consume the ESC and the following byte.
  return 2
}

/** True once an SGR run other than a reset is open, so clipping can re-close it. */
function opensStyle(seq: string): boolean | null {
  if (!seq.endsWith('m')) {
    return null
  }
  return seq !== `${ESC}[0m` && seq !== `${ESC}[m`
}

export function cellWidth(text: string): number {
  let width = 0
  let i = 0
  while (i < text.length) {
    const esc = escapeLength(text, i)
    if (esc > 0) {
      i += esc
      continue
    }
    const cp = text.codePointAt(i) ?? 0
    width += charWidth(cp)
    i += cp > 0xffff ? 2 : 1
  }
  return width
}

/** Truncate a possibly-styled line to at most `width` visible cells, passing SGR
 *  escapes through and re-closing any open style at the cut. */
export function clipAnsi(line: string, width: number): string {
  if (width <= 0) {
    return ''
  }
  let out = ''
  let visible = 0
  let styleOpen = false
  let i = 0
  while (i < line.length) {
    const esc = escapeLength(line, i)
    if (esc > 0) {
      const seq = line.slice(i, i + esc)
      out += seq
      const opens = opensStyle(seq)
      if (opens !== null) {
        styleOpen = opens
      }
      i += esc
      continue
    }
    const cp = line.codePointAt(i) ?? 0
    const w = charWidth(cp)
    if (visible + w > width) {
      break
    }
    out += String.fromCodePoint(cp)
    visible += w
    i += cp > 0xffff ? 2 : 1
  }
  return styleOpen ? `${out}${ESC}[0m` : out
}

/** Return the tail of a styled line after skipping `start` visible cells,
 *  re-emitting the SGR style in effect at the cut so the tail renders correctly.
 *  The complement of clipAnsi — used to composite a box over the middle of a row
 *  while preserving the cells on either side. */
export function sliceCellsFrom(line: string, start: number): string {
  if (start <= 0) {
    return line
  }
  let visible = 0
  // Track the stack of active opening SGR runs so stacked styles (e.g. color +
  // bold) are all re-emitted on the tail; a reset clears the stack.
  const activeSgr: string[] = []
  let i = 0
  while (i < line.length && visible < start) {
    const esc = escapeLength(line, i)
    if (esc > 0) {
      const seq = line.slice(i, i + esc)
      const opens = opensStyle(seq)
      if (opens === true) {
        activeSgr.push(seq)
      } else if (opens === false) {
        activeSgr.length = 0
      }
      i += esc
      continue
    }
    const cp = line.codePointAt(i) ?? 0
    visible += charWidth(cp)
    i += cp > 0xffff ? 2 : 1
  }
  return activeSgr.join('') + line.slice(i)
}

/** Fit PLAIN text to exactly `width` cells: truncate when too wide, right-pad
 *  with spaces when too short. */
export function fitCells(text: string, width: number): string {
  if (width <= 0) {
    return ''
  }
  const w = cellWidth(text)
  if (w === width) {
    return text
  }
  if (w < width) {
    return text + ' '.repeat(width - w)
  }
  const cut = clipAnsi(text, width)
  const cutWidth = cellWidth(cut)
  return cutWidth < width ? cut + ' '.repeat(width - cutWidth) : cut
}

/** Pad a styled line (which already fits) with trailing spaces to `width`. */
export function padCells(line: string, width: number): string {
  const w = cellWidth(line)
  return w < width ? line + ' '.repeat(width - w) : line
}
