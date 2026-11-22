import { describe, expect, it } from 'vitest'
import { GrowingByteBuffer } from './growing-byte-buffer'

describe('GrowingByteBuffer', () => {
  it('copies live bytes without consuming them or exposing mutable storage', () => {
    const buffer = new GrowingByteBuffer()
    buffer.append(Buffer.from('prefix-tail'))
    buffer.retainSuffix(4)
    const snapshot = buffer.toBuffer()
    snapshot.fill(0)
    expect(buffer.toBuffer()).toEqual(Buffer.from('tail'))
    expect(buffer.byteLength).toBe(4)
    const retained = buffer.toBuffer()
    buffer.appendRetainedSuffix(Buffer.from('next'), 4)
    expect(retained).toEqual(Buffer.from('tail'))
    expect(buffer.toBuffer()).toEqual(Buffer.from('next'))
  })

  it('transfers binary bytes without changing them on clear or reuse', () => {
    const buffer = new GrowingByteBuffer()
    const bytes = Buffer.from([0, 255, 128, 10, 0])
    buffer.append(bytes.subarray(0, 2))
    buffer.append(bytes.subarray(2))
    const taken = buffer.takeBuffer()
    expect(taken).toEqual(bytes)
    expect(buffer.byteLength).toBe(0)
    expect(buffer.takeBuffer()).toEqual(Buffer.alloc(0))
    buffer.append(Buffer.alloc(1024, 7))
    buffer.clear()
    expect(taken).toEqual(bytes)
  })

  it('appends only a bounded copy from an oversized source chunk', () => {
    const buffer = new GrowingByteBuffer()
    buffer.append(Buffer.from('old'))
    const source = Buffer.from('discard-prefix-tail')

    buffer.appendRetainedSuffix(source, 4)
    source.fill(0)

    expect(buffer.byteLength).toBe(4)
    expect(buffer.toString()).toBe('tail')
  })
})
