import { describe, expect, it } from 'vitest'
import { LspCreditWindow, LSP_ACK_WINDOW_CHUNKS } from './lsp-credit-window'

describe('LspCreditWindow', () => {
  it('mints monotonic seqs and tracks the outstanding count', () => {
    const window = new LspCreditWindow({ windowChunks: 4 })
    expect(window.unacked()).toBe(0)
    expect(window.nextOutboundSeq()).toBe(1)
    window.recordSent()
    expect(window.unacked()).toBe(1)
    expect(window.shouldPause()).toBe(false)
    expect(window.nextOutboundSeq()).toBe(2)
    window.recordSent()
    expect(window.unacked()).toBe(2)
  })

  it('pauses once the unacked count reaches the window', () => {
    const window = new LspCreditWindow({ windowChunks: 3 })
    for (let i = 0; i < 3; i++) {
      window.nextOutboundSeq()
      window.recordSent()
    }
    // 3 sent, 0 acked, window 3 → paused
    expect(window.unacked()).toBe(3)
    expect(window.shouldPause()).toBe(true)
  })

  it('throws when minting a seq while paused (caller must check shouldPause)', () => {
    const window = new LspCreditWindow({ windowChunks: 1 })
    window.nextOutboundSeq()
    window.recordSent()
    expect(window.shouldPause()).toBe(true)
    expect(() => window.nextOutboundSeq()).toThrow(/paused/)
  })

  it('reopens the window when an ack drops the outstanding count below the limit', () => {
    const window = new LspCreditWindow({ windowChunks: 2 })
    window.nextOutboundSeq()
    window.recordSent()
    window.nextOutboundSeq()
    window.recordSent()
    expect(window.shouldPause()).toBe(true)
    // Ack the first frame → 1 outstanding, below window 2 → reopens
    expect(window.recordAck(1)).toBe(true)
    expect(window.shouldPause()).toBe(false)
  })

  it('a partial ack that still leaves the window full does not reopen', () => {
    const window = new LspCreditWindow({ windowChunks: 4 })
    for (let i = 0; i < 4; i++) {
      window.nextOutboundSeq()
      window.recordSent()
    }
    expect(window.shouldPause()).toBe(true)
    // Ack only seq 1 → 3 outstanding, still >= window 4 is false (3 < 4) → reopens
    expect(window.recordAck(1)).toBe(true)
  })

  it('ignores stale/duplicate acks (highest-seen monotonic)', () => {
    const window = new LspCreditWindow({ windowChunks: 4 })
    window.nextOutboundSeq()
    window.recordSent()
    window.recordAck(1)
    expect(window.unacked()).toBe(0)
    // A stale ack for an already-acked seq is a no-op
    window.recordAck(1)
    expect(window.unacked()).toBe(0)
  })

  it('rejects non-integer ack seqs', () => {
    const window = new LspCreditWindow()
    expect(() => window.recordAck(Number.NaN)).toThrow(/non-negative integer/)
    expect(() => window.recordAck(1.5)).toThrow(/non-negative integer/)
  })

  it('defaults to STREAM_ACK_WINDOW_CHUNKS parity', () => {
    const window = new LspCreditWindow()
    for (let i = 0; i < LSP_ACK_WINDOW_CHUNKS; i++) {
      window.nextOutboundSeq()
      window.recordSent()
    }
    expect(window.shouldPause()).toBe(true)
  })

  it('rejects a non-positive window at construction', () => {
    expect(() => new LspCreditWindow({ windowChunks: 0 })).toThrow(/positive integer/)
    expect(() => new LspCreditWindow({ windowChunks: -1 })).toThrow(/positive integer/)
    expect(() => new LspCreditWindow({ windowChunks: 2.5 })).toThrow(/positive integer/)
  })
})
