// Pure credit-window state for the relay `lsp.*` stdout backpressure (spec
// §4 relay row + D8: "credit 背压照抄现有 pty 模式"). Kept separate from the
// spawn/pipe machinery so the framing + backpressure invariant is a pure unit:
// given a credit window and a sequence of outbound data / inbound acks, assert
// the pump pauses and resumes at the right thresholds. Mirrors the
// STREAM_ACK_WINDOW_CHUNKS ack model (protocol.ts) applied per LSP session.
//
// The model: the relay emits `lsp.data` frames each carrying a monotonic `seq`
// and a base64 stdout chunk. The client acks consumed seqs via `lsp.ack`. The
// relay pauses stdout reads while (sent - acked) >= window so a slow SSH
// channel cannot be flooded; it resumes once an ack opens the window again.

/** Default unacked-frame window for `lsp.data` (mirrors STREAM_ACK_WINDOW_CHUNKS). */
export const LSP_ACK_WINDOW_CHUNKS = 4

export type LspCreditWindowOptions = {
  /** Max unacked `lsp.data` frames in flight before stdout reading pauses. */
  windowChunks?: number
}

/**
 * Bounded credit window for one LSP session's stdout stream. Pure: no I/O, no
 * timers. The handler calls `recordSent` per emitted frame, `recordAck` per
 * inbound `lsp.ack`, and reads `shouldPause` to gate the stdout pipe.
 */
export class LspCreditWindow {
  private readonly windowChunks: number
  private nextSeq = 1
  private highestAckedSeq = 0
  private paused = false

  constructor(options: LspCreditWindowOptions = {}) {
    const windowChunks = options.windowChunks ?? LSP_ACK_WINDOW_CHUNKS
    if (!Number.isInteger(windowChunks) || windowChunks < 1) {
      throw new Error(`LSP credit window must be a positive integer, got ${windowChunks}`)
    }
    this.windowChunks = windowChunks
  }

  /** Mint the next outbound seq. Throws if the window is exhausted (caller bug). */
  nextOutboundSeq(): number {
    if (this.paused) {
      throw new Error('Cannot mint seq while the credit window is paused')
    }
    return this.nextSeq++
  }

  /** Ack frames up to and including `seq`; returns true if the window reopened. */
  recordAck(seq: number): boolean {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new Error(`LSP ack seq must be a non-negative integer, got ${seq}`)
    }
    if (seq > this.highestAckedSeq) {
      this.highestAckedSeq = seq
    }
    const reopened = this.paused && this.unacked() < this.windowChunks
    if (reopened) {
      this.paused = false
    }
    return reopened
  }

  /** Mark a frame sent (advances the outstanding count); pauses if at the window. */
  recordSent(): void {
    if (this.unacked() >= this.windowChunks) {
      this.paused = true
    }
  }

  shouldPause(): boolean {
    return this.paused
  }

  /** Outstanding unacked frames (sent - acked). */
  unacked(): number {
    return this.nextSeq - 1 - this.highestAckedSeq
  }
}
