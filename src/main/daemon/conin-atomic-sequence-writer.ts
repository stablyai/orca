// Why this module exists: ConPTY's input parser does not keep VT parser state
// across conin write boundaries. An escape sequence split across two writes
// deterministically loses its head (silently swallowed) and delivers its tail
// to the foreground app as literal keystrokes — e.g. a split `\x1b[?997;1` +
// `n` types "n", and a split bracketed-paste end marker leaves the app stuck
// in paste mode, where Backspace inserts a blank-rendering literal instead of
// deleting ("backspace types a space" after session resume). Holding a
// trailing partial sequence until its continuation arrives lets the daemon
// hand ConPTY only whole sequences.
import {
  extractPartialEscapeTail,
  MAX_PARTIAL_ESCAPE_TAIL_LENGTH
} from '../../shared/terminal-partial-escape-tail'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'

// Why two windows: a bare ESC is (almost always) a real Escape keypress, so it
// must flush fast enough that Escape stays responsive; a longer partial (CSI/
// OSC/DCS body) can never be a bare human keypress, so it may wait longer for
// its continuation under daemon load.
export const CONIN_BARE_ESC_FLUSH_MS = 15
export const CONIN_PARTIAL_SEQUENCE_FLUSH_MS = 150

const ESC = '\x1b'
// ESC continuation openers: CSI `[`, OSC `]`, SS3 `O`, DCS `P`, SOS `X`,
// PM `^`, APC `_`. Anything else after a held bare ESC is treated as an
// independent keypress (ESC key, then the next key) and flushed separately so
// e.g. Escape followed quickly by a letter cannot be fused into an Alt-chord.
const ESC_CONTINUATION_OPENERS = new Set(['[', ']', 'O', 'P', 'X', '^', '_'])

export type ConinAtomicSequenceWriterOptions = {
  sessionIdSuffix?: string
  bareEscFlushMs?: number
  partialSequenceFlushMs?: number
}

export class ConinAtomicSequenceWriter {
  private heldTail = ''
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly sink: (data: string) => void
  private readonly sessionIdSuffix: string
  private readonly bareEscFlushMs: number
  private readonly partialSequenceFlushMs: number

  constructor(sink: (data: string) => void, opts: ConinAtomicSequenceWriterOptions = {}) {
    this.sink = sink
    this.sessionIdSuffix = opts.sessionIdSuffix ?? ''
    this.bareEscFlushMs = opts.bareEscFlushMs ?? CONIN_BARE_ESC_FLUSH_MS
    this.partialSequenceFlushMs = opts.partialSequenceFlushMs ?? CONIN_PARTIAL_SEQUENCE_FLUSH_MS
  }

  get pendingTail(): string {
    return this.heldTail
  }

  write(data: string): void {
    if (this.disposed) {
      return
    }
    if (data.length === 0) {
      return
    }
    if (this.heldTail === ESC && !ESC_CONTINUATION_OPENERS.has(data[0])) {
      // Held bare ESC + a non-opener: two independent keypresses. Flush the
      // ESC as its own write so they are not fused into an Alt-chord.
      this.flushHeldTail('esc-then-key')
    }
    const combined = this.heldTail + data
    this.clearFlushTimer()
    const joinedFromHeldTail = this.heldTail.length > 0
    const tail = extractPartialEscapeTail(combined)
    if (tail.length > MAX_PARTIAL_ESCAPE_TAIL_LENGTH) {
      // Pathological unterminated OSC/DCS: stop guarding, pass through.
      this.heldTail = ''
      this.sink(combined)
      return
    }
    const complete = combined.slice(0, combined.length - tail.length)
    this.heldTail = tail
    if (complete.length > 0) {
      if (joinedFromHeldTail) {
        recordDaemonStreamBacklogEvent('coninJoinedSplitSequence', {
          sessionIdSuffix: this.sessionIdSuffix,
          joinedChars: complete.length
        })
      }
      this.sink(complete)
    }
    if (this.heldTail.length > 0) {
      this.armFlushTimer()
    }
  }

  /** Write the held partial as-is (degrades to pre-guard behavior). */
  private flushHeldTail(reason: 'timeout' | 'esc-then-key'): void {
    this.clearFlushTimer()
    const tail = this.heldTail
    if (tail.length === 0) {
      return
    }
    this.heldTail = ''
    // A flushed bare ESC is a normal Escape keypress, not a corruption signal.
    if (tail !== ESC) {
      recordDaemonStreamBacklogEvent('coninFlushedDanglingPartial', {
        sessionIdSuffix: this.sessionIdSuffix,
        reason,
        tailChars: tail.length
      })
    }
    this.sink(tail)
  }

  private armFlushTimer(): void {
    const delay = this.heldTail === ESC ? this.bareEscFlushMs : this.partialSequenceFlushMs
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushHeldTail('timeout')
    }, delay)
    this.flushTimer.unref?.()
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  /** Drop held state without writing — the PTY is gone. */
  dispose(): void {
    this.disposed = true
    this.clearFlushTimer()
    this.heldTail = ''
  }
}
