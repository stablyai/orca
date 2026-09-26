import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeTerminalHistoryLog, encodeLogBatch, encodeLogHeader } from './terminal-history-log'
import type { PendingOutputRecord } from './types'

afterEach(() => vi.restoreAllMocks())

describe('terminal history batch encoding', () => {
  it('preserves released bytes for empty, Unicode, resize and clear records', () => {
    const records: PendingOutputRecord[] = [
      { kind: 'output', data: '' },
      { kind: 'output', data: 'Aé🐳\ud800\u0000\x1b[31m' },
      { kind: 'resize', cols: -1, rows: 65536 },
      { kind: 'resize', cols: 80.9, rows: 24.9 },
      { kind: 'clear' }
    ]
    const encoded = encodeLogBatch(0x1_ffff_ffff, records)
    expect(encoded.toString('hex')).toBe(
      '0104000000ffffffff0200000000021000000041c3a9f09f90b3efbfbd001b5b33316d03040000000000ffff0304000000500018000400000000'
    )
    expect(decodeTerminalHistoryLog(Buffer.concat([encodeLogHeader(3), encoded]))).toEqual({
      generation: 3,
      truncatedTail: false,
      batches: [
        {
          seq: 0xffff_ffff,
          records: [
            { kind: 'output', data: '' },
            { kind: 'output', data: 'Aé🐳\ufffd\u0000\x1b[31m' },
            { kind: 'resize', cols: 0, rows: 65535 },
            { kind: 'resize', cols: 80, rows: 24 },
            { kind: 'clear' }
          ]
        }
      ]
    })
    expect(encodeLogBatch(-1, []).toString('hex')).toBe('0104000000ffffffff')
  })

  it('encodes a 4 MiB checkpoint increment without intermediate framed buffers', () => {
    const records: PendingOutputRecord[] = Array.from({ length: 1024 }, () => ({
      kind: 'output',
      data: 'x'.repeat(4096)
    }))
    const alloc = vi.spyOn(Buffer, 'alloc')
    const allocUnsafe = vi.spyOn(Buffer, 'allocUnsafe')
    const from = vi.spyOn(Buffer, 'from')
    const concat = vi.spyOn(Buffer, 'concat')

    const encoded = encodeLogBatch(17, records)
    const observed = {
      alloc: alloc.mock.calls.length,
      allocUnsafe: allocUnsafe.mock.calls.length,
      from: from.mock.calls.length,
      concat: concat.mock.calls.length,
      concatBytes: concat.mock.results.reduce(
        (bytes, result) =>
          result.type === 'return' && Buffer.isBuffer(result.value)
            ? bytes + result.value.length
            : bytes,
        0
      )
    }
    vi.restoreAllMocks()
    console.info(
      JSON.stringify({ records: records.length, encodedBytes: encoded.length, ...observed })
    )

    expect(encoded.length).toBe(9 + 1024 * (5 + 4096))
    expect(decodeTerminalHistoryLog(Buffer.concat([encodeLogHeader(0), encoded]))?.batches).toEqual(
      [{ seq: 17, records }]
    )
    expect(observed).toEqual({ alloc: 0, allocUnsafe: 1, from: 1024, concat: 0, concatBytes: 0 })
  })

  it('keeps UTF-16 replacement local to each output record', () => {
    const encoded = encodeLogBatch(1, [
      { kind: 'output', data: '\ud800' },
      { kind: 'output', data: '\udc00' },
      { kind: 'output', data: '\ud800\udc00' }
    ])
    expect(encoded.toString('hex')).toBe(
      '0104000000010000000203000000efbfbd0203000000efbfbd0204000000f0908080'
    )
  })
})
