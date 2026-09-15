import { describe, expect, it, vi } from 'vitest'
import { handleTerminalBinaryFrame } from './rpc-client-terminal-binary-frame'
import {
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  TerminalStreamOpcode
} from '../../../src/shared/terminal-stream-protocol'

/**
 * STA-3482. The host emits `OutputSpan` (opcode 15) instead of `Output` whenever a chunk was
 * transformed or its raw sequence length differs from the display text — ordinary PTY ingress
 * does this, and nothing gates the opcode behind capability negotiation. Mobile vendored only
 * 7 of the 17 opcodes, so its decoder rejected opcode 15 and dropped the whole frame: terminal
 * output silently vanished on phones.
 */
function encodeOutputSpanFrame(args: {
  streamId: number
  seq: number
  data: string
  rawLength: number
}): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.OutputSpan,
    streamId: args.streamId,
    seq: args.seq,
    payload: encodeTerminalStreamJson({
      data: args.data,
      rawLength: args.rawLength,
      transformed: true
    })
  })
}

describe('terminal OutputSpan frames on mobile (STA-3482)', () => {
  it('delivers transformed output to the stream listener', () => {
    const listener = vi.fn()
    const recordValidatedInboundTraffic = vi.fn()

    handleTerminalBinaryFrame(
      encodeOutputSpanFrame({ streamId: 7, seq: 120, data: 'hello from the host', rawLength: 25 }),
      {
        terminalSnapshots: new Map(),
        getListener: (streamId) => (streamId === 7 ? listener : undefined),
        recordValidatedInboundTraffic
      }
    )

    expect(listener).toHaveBeenCalledWith({
      type: 'data',
      streamId: 7,
      chunk: 'hello from the host'
    })
    expect(recordValidatedInboundTraffic).toHaveBeenCalledTimes(1)
  })

  it('drops a span whose JSON does not carry the transformed contract', () => {
    const listener = vi.fn()
    const recordValidatedInboundTraffic = vi.fn()

    handleTerminalBinaryFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.OutputSpan,
        streamId: 7,
        seq: 1,
        // Why: rendering malformed span JSON would print protocol framing as terminal text.
        payload: encodeTerminalStreamJson({ data: 'x', rawLength: -1, transformed: true })
      }),
      {
        terminalSnapshots: new Map(),
        getListener: () => listener,
        recordValidatedInboundTraffic
      }
    )

    expect(listener).not.toHaveBeenCalled()
  })
})
