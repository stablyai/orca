// Decodes terminal.subscribe binary frames (@orca-shared/terminal-stream-protocol) into
// displayable HUD text: ANSI/CSI/OSC stripped, tabs expanded, hard-wrapped at maxCols, only the
// last maxLines kept. Fidelity target is "readable tail", not a full xterm emulation.
import {
  TerminalStreamOpcode,
  type TerminalStreamFrame
} from '@orca-shared/terminal-stream-protocol'

export type TerminalTailDecoderOptions = {
  maxLines?: number
  maxCols?: number
}

// Strips: OSC sequences (ESC ] ... BEL | ESC \), CSI sequences (ESC [ ... final byte),
// two-byte ESC sequences, and remaining C0 control bytes (except \t \n \r, handled separately).
const CONTROL_SEQUENCE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g

function stripAnsi(text: string): string {
  return text.replace(CONTROL_SEQUENCE_PATTERN, '')
}

function expandTabs(text: string, tabWidth = 8): string {
  let result = ''
  let column = 0
  for (const ch of text) {
    if (ch === '\t') {
      const spaces = tabWidth - (column % tabWidth)
      result += ' '.repeat(spaces)
      column += spaces
    } else {
      result += ch
      column += 1
    }
  }
  return result
}

function hardWrap(line: string, maxCols: number): string[] {
  if (line.length <= maxCols) {
    return [line]
  }
  const wrapped: string[] = []
  for (let i = 0; i < line.length; i += maxCols) {
    wrapped.push(line.slice(i, i + maxCols))
  }
  return wrapped
}

export class TerminalTailDecoder {
  private readonly maxLines: number
  private readonly maxCols: number
  private completedLines: string[] = []
  private currentLine = ''
  private readonly decoder = new TextDecoder()

  constructor(opts: TerminalTailDecoderOptions = {}) {
    this.maxLines = opts.maxLines ?? 120
    this.maxCols = opts.maxCols ?? 60
  }

  pushFrame(frame: TerminalStreamFrame): void {
    switch (frame.opcode) {
      case TerminalStreamOpcode.SnapshotStart:
        // Why: a fresh snapshot replaces the tail entirely — mirrors opcode semantics in
        // @orca-shared/terminal-stream-protocol (SnapshotStart begins a full-buffer resend).
        // The payload itself is JSON snapshot metadata (kind/cols/rows/cwd/...), not terminal
        // text — see terminal-snapshot-publication.ts's sendSnapshotFrames — so it's dropped;
        // terminal text starts with SnapshotChunk.
        this.reset()
        break
      case TerminalStreamOpcode.SnapshotChunk:
      case TerminalStreamOpcode.Output:
        this.appendText(this.decoder.decode(frame.payload))
        break
      case TerminalStreamOpcode.Error: {
        const message = this.decoder.decode(frame.payload).trim() || 'terminal stream error'
        this.appendText(`\n[error] ${message}\n`)
        break
      }
      // SnapshotEnd (content already appended) and Resized (fixed-width HUD) are no-ops.
    }
  }

  lines(): string[] {
    // Why: an empty currentLine after content ending exactly on a newline boundary is not a
    // real trailing blank line — only surface it when it's the sole line seen so far.
    const all =
      this.currentLine.length > 0 || this.completedLines.length === 0
        ? [...this.completedLines, this.currentLine]
        : this.completedLines
    const wrapped: string[] = []
    for (const raw of all) {
      const cleaned = expandTabs(stripAnsi(raw))
      for (const piece of hardWrap(cleaned, this.maxCols)) {
        wrapped.push(piece)
      }
    }
    return wrapped.slice(-this.maxLines)
  }

  private reset(): void {
    this.completedLines = []
    this.currentLine = ''
  }

  private appendText(text: string): void {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const parts = normalized.split('\n')
    this.currentLine += parts[0] ?? ''
    for (let i = 1; i < parts.length; i++) {
      this.completedLines.push(this.currentLine)
      this.currentLine = parts[i] ?? ''
    }
  }
}
