import { describe, expect, it } from 'vitest'
import { RexSnapshotFramer, snapshotEnd } from './rex-snapshot-framing'

function envelope(version = 1): Buffer {
  const header = Buffer.alloc(10)
  header.write('GHOSTSNP')
  header.writeUInt16LE(version, 8)
  return header
}

function record(tag: number, payload: string): Buffer {
  const header = Buffer.alloc(10)
  header.writeUInt16LE(tag)
  header.writeUInt32LE(Buffer.byteLength(payload), 2)
  return Buffer.concat([header, Buffer.from(payload)])
}

describe('Rex snapshot framing', () => {
  it('does not treat embedded markers as a boundary and preserves the VT tail', () => {
    const snapshot = Buffer.concat([envelope(), record(1, 'GHOSTSNP'), record(6, 'end')])
    const input = Buffer.concat([snapshot, Buffer.from('\x1b[31mhello')])
    for (let i = 0; i < snapshot.length; i++) {
      expect(snapshotEnd(input.subarray(0, i))).toBeNull()
    }
    expect(snapshotEnd(input)).toBe(snapshot.length)
    for (let i = 0; i < snapshot.length; i++) {
      const framer = new RexSnapshotFramer()
      expect(framer.feed(input.subarray(0, i))).toBeNull()
      expect(framer.feed(input.subarray(i))).toBe(snapshot.length - i)
    }
    expect(input.subarray(snapshotEnd(input)!).toString()).toBe('\x1b[31mhello')
  })

  it('fails closed on unsupported versions and oversized record lengths', () => {
    expect(() => snapshotEnd(envelope(2))).toThrow('Unsupported Rex snapshot')
    const header = Buffer.alloc(10)
    header.writeUInt32LE(0xffffffff, 2)
    expect(() => snapshotEnd(Buffer.concat([envelope(), header]))).toThrow('record too large')
  })
})
