import { describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame
} from '../../../../shared/terminal-stream-protocol'
import { sendSnapshotFrames } from './terminal/terminal-snapshot-publication'
import { publishMultiplexInitialSnapshot } from './terminal/terminal-multiplex-initial-snapshot'
import { TerminalSourceRangeRegistry } from '../terminal-source-range-registry'
import { initializeMultiplexStream } from './terminal/terminal-multiplex-stream-initialization'
import type { TerminalMultiplexConnection } from './terminal/terminal-multiplex-connection'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { TerminalMultiplexStream } from './terminal/terminal-stream-types'

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

  it('publishes the latest nonempty initial image when startup output overflows twice', async () => {
    const frames: { opcode: TerminalStreamOpcode; payload: Uint8Array<ArrayBufferLike> }[] = []
    const emit = vi.fn()
    let readCount = 0
    const stream = {
      streamId: 7,
      terminal: 'terminal',
      ptyId: 'pty',
      isMobile: false,
      ackOutputSourceRanges: false,
      supportsOutputPause: false,
      pendingOutput: [{ data: 'lost-live', bytes: 9 }],
      pendingOutputBytes: 9,
      pendingOutputOverflowed: true,
      outputBatcher: { push: vi.fn(), flush: vi.fn() }
    } as unknown as TerminalMultiplexStream
    const runtime = {
      readTerminal: vi.fn(async () => {
        readCount += 1
        if (readCount === 2) {
          stream.pendingOutputOverflowed = true
        }
        return { tail: ['fallback'] }
      }),
      serializeTerminalBuffer: vi.fn(async () => ({
        data: 'AUTHORITATIVE_INITIAL_MARKER',
        cols: 80,
        rows: 24,
        seq: 41,
        scrollbackRows: 0,
        truncatedByByteBudget: false
      })),
      getTerminalSize: vi.fn(() => ({ cols: 80, rows: 24 })),
      getMobileDisplayMode: vi.fn(() => 'fit'),
      getLayout: vi.fn(() => null)
    } as unknown as OrcaRuntimeService
    const state = {
      runtime,
      streams: new Map([[stream.streamId, stream]]),
      emit,
      closed: false,
      sendFrame: vi.fn((streamId, opcode, payload = new Uint8Array()) => {
        expect(streamId).toBe(stream.streamId)
        frames.push({ opcode, payload })
        return true
      })
    } as unknown as TerminalMultiplexConnection

    await publishMultiplexInitialSnapshot(
      state,
      { streamId: stream.streamId, terminal: stream.terminal },
      stream
    )

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subscribed', truncated: true })
    )
    expect(frames.map(({ opcode }) => opcode)).toEqual([
      TerminalStreamOpcode.SnapshotStart,
      TerminalStreamOpcode.SnapshotChunk,
      TerminalStreamOpcode.SnapshotEnd
    ])
    expect(decodeTerminalStreamJson(frames[0]!.payload)).toMatchObject({
      seq: 41,
      truncated: true
    })
    expect(decodeTerminalStreamText(frames[1]!.payload)).toBe('AUTHORITATIVE_INITIAL_MARKER')
    expect(stream.outputBatcher.push).not.toHaveBeenCalled()
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
