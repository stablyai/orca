/** A decoded, layout-aware logical key. Raw terminal byte sequences are mapped
 *  to these so the keybinding layer never matches on physical escape codes.
 *  (Bytes forwarded into a focused shell are handled separately — this decoder
 *  is only for Orca-command input.) */
export type LogicalKey =
  | { type: 'char'; value: string }
  | { type: 'ctrl'; value: string }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'enter' }
  | { type: 'escape' }
  | { type: 'tab' }
  | { type: 'backspace' }

const ARROWS: Record<string, LogicalKey> = {
  '\x1b[A': { type: 'up' },
  '\x1b[B': { type: 'down' },
  '\x1b[C': { type: 'right' },
  '\x1b[D': { type: 'left' },
  // SS3 variants emitted by some terminals in application cursor mode
  '\x1bOA': { type: 'up' },
  '\x1bOB': { type: 'down' },
  '\x1bOC': { type: 'right' },
  '\x1bOD': { type: 'left' }
}

/** Decode a single key event's bytes into a logical key, or null if the bytes
 *  are not a recognized single key (e.g. a mouse report — see mouse-input). */
export function decodeKey(data: string): LogicalKey | null {
  if (data.length === 0) {
    return null
  }

  const arrow = ARROWS[data]
  if (arrow) {
    return arrow
  }

  if (data === '\r' || data === '\n') {
    return { type: 'enter' }
  }
  if (data === '\t') {
    return { type: 'tab' }
  }
  if (data === '\x1b') {
    return { type: 'escape' }
  }
  if (data === '\x7f' || data === '\b') {
    return { type: 'backspace' }
  }

  if (data.length === 1) {
    const code = data.charCodeAt(0)
    // Control characters Ctrl+A..Ctrl+Z map to codes 1..26.
    if (code >= 1 && code <= 26) {
      return { type: 'ctrl', value: String.fromCharCode(code + 96) }
    }
    if (code >= 32) {
      return { type: 'char', value: data }
    }
  }

  return null
}

/** True for the bytes of an SGR mouse report, which decodeKey must not treat as
 *  a key. Full parsing lives in mouse-input; this is the quick discriminator. */
export function isMouseSequence(data: string): boolean {
  return data.startsWith('\x1b[<')
}
