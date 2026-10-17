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

// Finding #20: how far completedLines is allowed to grow past maxLines before it gets trimmed
// back. A small slack avoids re-slicing the array on every single completed line.
const RETENTION_MARGIN = 32

export class TerminalTailDecoder {
  private readonly maxLines: number
  private readonly maxCols: number
  // Already ANSI-stripped/tab-expanded/hard-wrapped, bounded to ~maxLines during ingestion
  // (finding #20) — cleaning happens once per completed line, not on every lines() call.
  private completedLines: string[] = []
  private currentLine = '' // raw, uncleaned: only the in-progress line, cleaned lazily in lines()
  private readonly decoder = new TextDecoder()
  // Finding #4 (residual): distinguishes "nothing has ever arrived" from "a real but currently
  // blank line" — both otherwise present as completedLines:[]/currentLine:'' — so lines() can
  // return [] (no output yet) instead of a phantom [''] before any content is received.
  private hasContent = false

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
    // real trailing blank line — only surface it when it's the sole line seen so far, and only
    // once something has actually arrived (finding #4 residual: never fabricate a blank line
    // for a terminal that hasn't sent anything yet).
    const cleanedCurrent = expandTabs(stripAnsi(this.currentLine))
    const currentWrapped =
      cleanedCurrent.length > 0 || (this.hasContent && this.completedLines.length === 0)
        ? hardWrap(cleanedCurrent, this.maxCols)
        : []
    const all =
      currentWrapped.length > 0 ? [...this.completedLines, ...currentWrapped] : this.completedLines
    return all.slice(-this.maxLines)
  }

  /** Test/debug hook (finding #20): total retained lines, to assert the ingestion-time bound. */
  retainedLineCount(): number {
    return this.completedLines.length + (this.currentLine.length > 0 ? 1 : 0)
  }

  private reset(): void {
    this.completedLines = []
    this.currentLine = ''
    this.hasContent = false
  }

  private appendText(text: string): void {
    if (text.length > 0) {
      this.hasContent = true
    }
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const parts = normalized.split('\n')
    this.currentLine += parts[0] ?? ''
    this.trimCurrentLineIfHuge()
    for (let i = 1; i < parts.length; i++) {
      this.completeLine(this.currentLine)
      this.currentLine = parts[i] ?? ''
      this.trimCurrentLineIfHuge()
    }
  }

  /** Cleans + wraps one finished line and appends it, then trims completedLines back toward
   *  maxLines (finding #20) — bounds retention during ingestion instead of only at read time. */
  private completeLine(raw: string): void {
    const cleaned = expandTabs(stripAnsi(raw))
    for (const piece of hardWrap(cleaned, this.maxCols)) {
      this.completedLines.push(piece)
    }
    if (this.completedLines.length > this.maxLines + RETENTION_MARGIN) {
      this.completedLines = this.completedLines.slice(-this.maxLines)
    }
  }

  /** Bounds the raw in-progress line's byte growth for a busy terminal that never emits a
   *  newline (finding #20) — keep only the tail that could still matter for the final view. */
  private trimCurrentLineIfHuge(): void {
    const cap = this.maxCols * (this.maxLines + RETENTION_MARGIN)
    if (this.currentLine.length > cap) {
      this.currentLine = this.currentLine.slice(-cap)
    }
  }
}
