import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { createOsc133CommandFinishedScanner } from '../../shared/terminal-osc133-command-finished'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'

// eslint-disable-next-line no-control-regex -- control bytes are exactly what is not visible.
const VISIBLE_CHARACTER_RE = /[^\s\u0000-\u001f\u007f-\u009f]/

function hasVisibleText(normalizedText: string): boolean {
  return VISIBLE_CHARACTER_RE.test(stripAnsiEscapeSequences(normalizedText))
}

/** OSC 133;C follows the prompt/echo; only visible bytes after it prove the running command painted. */
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

/** Without markers (older fish, relay zsh, unwrapped shells, Windows command args), any output is the only paint evidence. */
export function hasTerminalCommandPainted(record: TerminalCommandPaintRecord): boolean {
  return record.commandPaint?.hasPainted() ?? true
}
