import { describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame
} from '../../../../shared/terminal-stream-protocol'
import { sendSnapshotFrames } from './terminal/terminal-snapshot-publication'
import { TerminalSourceRangeRegistry } from '../terminal-source-range-registry'
import { initializeMultiplexStream } from './terminal/terminal-multiplex-stream-initialization'
import type { TerminalMultiplexConnection } from './terminal/terminal-multiplex-connection'
import type { OrcaRuntimeService } from '../../orca-runtime'

// These assertions protect the permanent binary publication seam while its state machine
// lives in concrete terminal domain modules.
describe('terminal stream extraction characterization', () => {
  it('publishes an empty snapshot as Start then End without a synthetic chunk', () => {
    const frames: {
      opcode: TerminalStreamOpcode
      payload?: Uint8Array<ArrayBufferLike>
    }[] = []
    const stats = sendSnapshotFrames(
      (opcode, payload) => {
        frames.push({ opcode, payload })
      },
      {
        kind: 'scrollback',
        cols: 80,
        rows: 24,
        data: '',
        seq: 41,
        truncated: false,
        truncatedByByteBudget: false
      }
    )

    expect(frames.map((frame) => frame.opcode)).toEqual([
      TerminalStreamOpcode.SnapshotStart,
      TerminalStreamOpcode.SnapshotEnd
    ])
    expect(decodeTerminalStreamJson(frames[0]!.payload ?? new Uint8Array())).toEqual({
      kind: 'scrollback',
      cols: 80,
      rows: 24,
      seq: 41,
      truncated: false,
      truncatedByByteBudget: false
    })
    expect(stats).toEqual({ bytes: 0, chunks: 0, published: true })
  })

  it('stops publication immediately when SnapshotStart is rejected', () => {
    const opcodes: TerminalStreamOpcode[] = []
    const stats = sendSnapshotFrames(
      (opcode) => {
        opcodes.push(opcode)
        return false
      },
      {
        kind: 'scrollback',
        cols: 80,
        rows: 24,
        data: 'unpublished'
      }
    )

    expect(opcodes).toEqual([TerminalStreamOpcode.SnapshotStart])
    expect(stats).toEqual({ bytes: 0, chunks: 0, published: false })
  })

  it('keeps the permanent v1 header bytes and opcode assignments', () => {
    const seq = 2 ** 32 + 0x89abcdef
    const bytes = encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.WriteUnavailable,
      streamId: 0x78563412,
      seq,
      payload: new Uint8Array([0xaa])
    })
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    expect(Array.from(bytes.slice(0, 4))).toEqual([0x74, 1, 17, 0])
    expect(header.getUint32(4, true)).toBe(0x78563412)
    expect(header.getUint32(8, true)).toBe(1)
    expect(header.getUint32(12, true)).toBe(0x89abcdef)
    expect(bytes[16]).toBe(0xaa)
    expect([
      TerminalStreamOpcode.Output,
      TerminalStreamOpcode.SnapshotStart,
      TerminalStreamOpcode.SnapshotChunk,
      TerminalStreamOpcode.SnapshotEnd,
      TerminalStreamOpcode.Resized,
      TerminalStreamOpcode.Error,
      TerminalStreamOpcode.Input,
      TerminalStreamOpcode.Resize,
      TerminalStreamOpcode.Subscribe,
      TerminalStreamOpcode.Unsubscribe,
      TerminalStreamOpcode.SnapshotRequest,
      TerminalStreamOpcode.Metadata,
      TerminalStreamOpcode.Ack,
      TerminalStreamOpcode.ClaimViewport,
      TerminalStreamOpcode.OutputSpan,
      TerminalStreamOpcode.SetOutputPaused,
      TerminalStreamOpcode.WriteUnavailable
    ]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
  })

  it('lets a slot-handler registration throw escape before per-stream catch ownership begins', async () => {
    const streams = new Map()
    const runtime = {
      attachRemoteTerminalSourceRangeConsumer: vi.fn(() => false)
    } as unknown as OrcaRuntimeService
    const state = {
      runtime,
      connectionId: 'connection',
      streams,
      sourceRangeRegistry: new TerminalSourceRangeRegistry(),
      registerBinaryStreamHandler: vi.fn(() => {
        throw new Error('registrar-failed')
      }),
      sendFrame: vi.fn(),
      queueOrSendOutput: vi.fn()
    } as unknown as TerminalMultiplexConnection
    const installed = vi.fn()

    await expect(
      initializeMultiplexStream(state, { streamId: 7, terminal: 'terminal' }, 'pty', installed)
    ).rejects.toThrow('registrar-failed')
    expect(installed).not.toHaveBeenCalled()
    expect(streams.has(7)).toBe(true)
  })
})
