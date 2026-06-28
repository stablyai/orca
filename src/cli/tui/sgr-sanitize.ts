/** The runtime's serialized screen (SerializeAddon) is a *replay script* meant
 *  to be written to a blank terminal: it carries SGR color runs but ALSO cursor
 *  moves, cursor-home, private-mode sets (alt-screen, mouse, bracketed paste)
 *  and OSC strings. Writing those verbatim into our fixed viewport rectangle
 *  makes the host terminal execute them and corrupts the screen. We keep only
 *  what paints a single line in place: SGR runs and printable text, turning
 *  cursor-forward skips (used for runs of default-background cells) back into
 *  spaces so columns stay aligned. */

const ESC = '\x1b'

/** Strip a serialized line down to SGR + text (cursor/mode/OSC escapes removed,
 *  `CSI n C` forward-skips expanded to spaces). */
export function sanitizeToSgr(line: string): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    if (line[i] !== ESC) {
      out += line[i]
      i += 1
      continue
    }
    const next = line[i + 1]
    if (next === '[') {
      i = consumeCsi(line, i, (seq, params, final) => {
        if (final === 'm') {
          out += seq
        } else if (final === 'C') {
          out += ' '.repeat(Math.max(1, Number.parseInt(params, 10) || 1))
        }
        // Any other final (cursor move, clear, mode set) is dropped.
      })
      continue
    }
    if (next === ']') {
      i = consumeOsc(line, i)
      continue
    }
    // A two-byte escape (or a lone trailing ESC) — drop it.
    i += 2
  }
  return out
}

/** Advance past a CSI sequence starting at `start`, invoking `keep` with the
 *  full sequence, its parameter bytes, and the final byte. Returns the next
 *  index. */
function consumeCsi(
  line: string,
  start: number,
  keep: (seq: string, params: string, final: string) => void
): number {
  let j = start + 2
  // Parameter bytes 0x30–0x3F (digits, ';', '?') then intermediates 0x20–0x2F.
  while (j < line.length && line.charCodeAt(j) >= 0x30 && line.charCodeAt(j) <= 0x3f) {
    j += 1
  }
  while (j < line.length && line.charCodeAt(j) >= 0x20 && line.charCodeAt(j) <= 0x2f) {
    j += 1
  }
  if (j >= line.length) {
    return j // unterminated — drop the rest
  }
  keep(line.slice(start, j + 1), line.slice(start + 2, j), line[j])
  return j + 1
}

/** Advance past an OSC string (ESC ] … terminated by BEL or ST). */
function consumeOsc(line: string, start: number): number {
  let j = start + 2
  while (j < line.length && line[j] !== '\x07' && !(line[j] === ESC && line[j + 1] === '\\')) {
    j += 1
  }
  if (line[j] === '\x07') {
    return j + 1
  }
  if (line[j] === ESC) {
    return j + 2
  }
  return j
}
