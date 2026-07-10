import { describe, expect, it, vi } from 'vitest'
import { handleTerminalBinaryFrame } from './rpc-client-terminal-binary-frame'
import { encodeTerminalStreamFrame, TerminalStreamOpcode } from './terminal-stream-protocol'

function encodeFrame(opcode: TerminalStreamOpcode, streamId: number, payload: unknown): Uint8Array {
  const body =
    typeof payload === 'string'
      ? new TextEncoder().encode(payload)
      : new TextEncoder().encode(JSON.stringify(payload))
  return encodeTerminalStreamFrame({
    opcode,
    streamId,
    seq: 1,
    payload: body
  })
}

describe('handleTerminalBinaryFrame', () => {
  it('routes terminal metadata frames to the stream listener', () => {
    const listener = vi.fn()
    const recordValidatedInboundTraffic = vi.fn()

    handleTerminalBinaryFrame(
      encodeFrame(TerminalStreamOpcode.Metadata, 42, { cwd: '/repo/src' }),
      {
        terminalSnapshots: new Map(),
        getListener: (streamId) => (streamId === 42 ? listener : undefined),
        recordValidatedInboundTraffic
      }
    )

    expect(recordValidatedInboundTraffic).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ type: 'metadata', streamId: 42, cwd: '/repo/src' })
  })
})
