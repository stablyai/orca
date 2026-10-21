import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { createOsc133CommandFinishedScanner } from '../../shared/terminal-osc133-command-finished'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'

// eslint-disable-next-line no-control-regex -- control bytes are exactly what is not visible.
const VISIBLE_CHARACTER_RE = /[^\s\u0000-\u001f\u007f-\u009f]/

function hasVisibleText(normalizedText: string): boolean {
  return VISIBLE_CHARACTER_RE.test(stripAnsiEscapeSequences(normalizedText))
}

/**
 * Where the running command's own output begins. Orca's shell integration prints OSC 133;C
 * after the prompt and the echoed command line, right before the command runs, so only
 * visible output after it can be the command's.
 */
export class TerminalCommandPaint {
  private awaitingPaint = false
  private markerEndInChunk = -1
  private readonly scanner = createOsc133CommandFinishedScanner(
    () => {},
    (endInChunk) => {
      this.markerEndInChunk = endInChunk
    }
  )

  observe(data: string, normalizedText: string): void {
    this.markerEndInChunk = -1
    this.scanner.scan(data)
    if (this.markerEndInChunk !== -1) {
      // Why the rest of this chunk counts: a fast binary can paint in the same read as the marker.
      this.awaitingPaint = !hasVisibleText(
        normalizeTerminalChunk(data.slice(this.markerEndInChunk)).text
      )
      return
    }
    if (this.awaitingPaint && hasVisibleText(normalizedText)) {
      this.awaitingPaint = false
    }
  }

  hasPainted(): boolean {
    return !this.awaitingPaint
  }
}

export type TerminalCommandPaintRecord = { commandPaint?: TerminalCommandPaint }

/** `normalizedText` is the chunk as the tail buffer received it (pending escapes resolved). */
export function observeTerminalCommandPaint(
  record: TerminalCommandPaintRecord,
  data: string,
  normalizedText: string
): void {
  record.commandPaint ??= new TerminalCommandPaint()
  record.commandPaint.observe(data, normalizedText)
}

/**
 * Why no marker reads as painted: some launches get no command boundary (older fish, SSH relay
 * zsh, shells Orca could not wrap, and Windows launches that pass the command in shell args), so
 * any output is all the evidence there is.
 */
export function hasTerminalCommandPainted(record: TerminalCommandPaintRecord): boolean {
  return record.commandPaint?.hasPainted() ?? true
}
