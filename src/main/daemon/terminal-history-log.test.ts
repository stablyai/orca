import { describe, expect, it } from 'vitest'
import {
  decodeLogHeader,
  decodeTerminalHistoryLog,
  encodeLogBatch,
  encodeLogHeader,
  LOG_HEADER_BYTES
} from './terminal-history-log'
import type { PendingOutputRecord } from './types'

function buildLog(generation: number, batches: { seq: number; records: PendingOutputRecord[] }[]) {
  return Buffer.concat([
    encodeLogHeader(generation),
    ...batches.map((batch) => encodeLogBatch(batch.seq, batch.records))
  ])
}

describe('terminal history log codec', () => {
  it('round-trips header generation', () => {
    expect(decodeLogHeader(encodeLogHeader(0))).toBe(0)
    expect(decodeLogHeader(encodeLogHeader(42))).toBe(42)
  })

  it('rejects bad magic and unknown format versions', () => {
    expect(decodeLogHeader(Buffer.from('NOPE\x01\x00\x00\x00\x00', 'latin1'))).toBeNull()
    const wrongVersion = encodeLogHeader(1)
    wrongVersion.writeUInt8(99, 4)
    expect(decodeLogHeader(wrongVersion)).toBeNull()
    expect(decodeTerminalHistoryLog(wrongVersion)).toBeNull()
    expect(decodeLogHeader(Buffer.alloc(3))).toBeNull()
  })

  it('round-trips output, resize, and clear records', () => {
    const records: PendingOutputRecord[] = [
      { kind: 'output', data: 'hello \x1b[31mred\x1b[0m — émoji 🐳\r\n' },
      { kind: 'resize', cols: 132, rows: 43 },
      { kind: 'clear' },
      { kind: 'output', data: 'after clear' }
    ]
    const log = decodeTerminalHistoryLog(buildLog(7, [{ seq: 3, records }]))
    expect(log).not.toBeNull()
    expect(log!.generation).toBe(7)
    expect(log!.truncatedTail).toBe(false)
    expect(log!.batches).toEqual([{ seq: 3, records }])
  })

  it('decodes multiple contiguous batches', () => {
    const log = decodeTerminalHistoryLog(
      buildLog(1, [
        { seq: 5, records: [{ kind: 'output', data: 'a' }] },
        { seq: 6, records: [{ kind: 'output', data: 'b' }] },
        { seq: 7, records: [] }
      ])
    )
    expect(log!.batches.map((batch) => batch.seq)).toEqual([5, 6, 7])
  })

  it('rejects the whole log on a batch sequence gap', () => {
    // Why: a gap means an appended take batch was lost (e.g. main crashed
    // between take and append); the byte stream has a hole, so replaying any
    // of it would corrupt the restored terminal.
    const log = decodeTerminalHistoryLog(
      buildLog(1, [
        { seq: 5, records: [{ kind: 'output', data: 'a' }] },
        { seq: 7, records: [{ kind: 'output', data: 'b' }] }
      ])
    )
    expect(log).toBeNull()
  })

  it('truncates a torn final frame and keeps the complete prefix', () => {
    const full = buildLog(2, [
      { seq: 1, records: [{ kind: 'output', data: 'complete' }] },
      { seq: 2, records: [{ kind: 'output', data: 'torn-away-tail' }] }
    ])
    for (const cut of [1, 3, 7] as const) {
      const torn = full.subarray(0, full.length - cut)
      const log = decodeTerminalHistoryLog(torn)
      expect(log).not.toBeNull()
      expect(log!.truncatedTail).toBe(true)
      expect(log!.batches[0]).toEqual({
        seq: 1,
        records: [{ kind: 'output', data: 'complete' }]
      })
    }
  })

  it('treats a record frame before any batch frame as unreadable', () => {
    const orphanRecord = Buffer.concat([
      encodeLogHeader(0),
      // encodeLogBatch always prefixes a batch frame; slice it off to craft
      // a stream that starts with a bare output frame.
      encodeLogBatch(1, [{ kind: 'output', data: 'x' }]).subarray(9)
    ])
    expect(decodeTerminalHistoryLog(orphanRecord)).toBeNull()
  })

  it('decodes an empty log (header only)', () => {
    const log = decodeTerminalHistoryLog(encodeLogHeader(4))
    expect(log).toEqual({ generation: 4, batches: [], truncatedTail: false })
    expect(LOG_HEADER_BYTES).toBe(encodeLogHeader(4).length)
  })
})
