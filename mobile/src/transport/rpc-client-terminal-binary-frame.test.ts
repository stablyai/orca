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

  it('assembles an ordinary snapshot without changing its payload', () => {
    const listener = vi.fn()
    const terminalSnapshots = new Map()
    const options = {
      terminalSnapshots,
      getListener: () => listener,
      recordValidatedInboundTraffic: vi.fn()
    }

    handleTerminalBinaryFrame(
      encodeFrame(TerminalStreamOpcode.SnapshotStart, 7, { kind: 'scrollback' }),
      options
    )
    handleTerminalBinaryFrame(encodeFrame(TerminalStreamOpcode.SnapshotChunk, 7, 'hello '), options)
    handleTerminalBinaryFrame(encodeFrame(TerminalStreamOpcode.SnapshotChunk, 7, 'world'), options)
    handleTerminalBinaryFrame(encodeFrame(TerminalStreamOpcode.SnapshotEnd, 7, ''), options)

    expect(listener).toHaveBeenCalledWith({
      kind: 'scrollback',
      serialized: 'hello world',
      streamId: 7,
      type: 'scrollback'
    })
    expect(terminalSnapshots.size).toBe(0)
  })

  it('drops cumulative snapshot data at the configured byte bound', () => {
    const listener = vi.fn()
    const terminalSnapshots = new Map()
    const options = {
      terminalSnapshots,
      getListener: () => listener,
      recordValidatedInboundTraffic: vi.fn(),
      maxSnapshotBytes: 5
    }

    handleTerminalBinaryFrame(encodeFrame(TerminalStreamOpcode.SnapshotStart, 7, {}), options)
    handleTerminalBinaryFrame(encodeFrame(TerminalStreamOpcode.SnapshotChunk, 7, '12345'), options)
    handleTerminalBinaryFrame(encodeFrame(TerminalStreamOpcode.SnapshotChunk, 7, '6'), options)

    expect(terminalSnapshots.size).toBe(0)
    expect(listener).toHaveBeenLastCalledWith({
      message: 'Terminal snapshot exceeded size limit.',
      streamId: 7,
      type: 'error'
    })
  })

  it('bounds tiny snapshot chunks independently of byte size', () => {
    const listener = vi.fn()
    const terminalSnapshots = new Map()
    const options = {
      terminalSnapshots,
      getListener: () => listener,
      recordValidatedInboundTraffic: vi.fn(),
      maxSnapshotChunks: 2
    }

    handleTerminalBinaryFrame(encodeFrame(TerminalStreamOpcode.SnapshotStart, 7, {}), options)
    handleTerminalBinaryFrame(encodeFrame(TerminalStreamOpcode.SnapshotChunk, 7, ''), options)
    handleTerminalBinaryFrame(encodeFrame(TerminalStreamOpcode.SnapshotChunk, 7, ''), options)
    handleTerminalBinaryFrame(encodeFrame(TerminalStreamOpcode.SnapshotChunk, 7, ''), options)

    expect(terminalSnapshots.size).toBe(0)
    expect(listener).toHaveBeenLastCalledWith({
      message: 'Terminal snapshot exceeded size limit.',
      streamId: 7,
      type: 'error'
    })
  })

  it('rejects a terminal frame before decoding an oversized payload', () => {
    const listener = vi.fn()

    handleTerminalBinaryFrame(encodeFrame(TerminalStreamOpcode.Metadata, 42, { value: 'large' }), {
      terminalSnapshots: new Map(),
      getListener: () => listener,
      recordValidatedInboundTraffic: vi.fn(),
      maxFramePayloadBytes: 4
    })

    expect(listener).toHaveBeenCalledWith({
      message: 'Terminal stream frame exceeded size limit.',
      streamId: 42,
      type: 'error'
    })
  })
})
