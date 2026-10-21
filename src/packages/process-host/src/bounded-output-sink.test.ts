import { describe, expect, it } from 'vitest'
import { createOutputSink } from './bounded-output-sink'

describe('bounded process output', () => {
  it('can read empty output and continue collecting', () => {
    const sink = createOutputSink(10)
    expect(sink.text()).toBe('')
    sink.write('one')
    expect(sink.text()).toBe('one')
    sink.write('two')
    expect(sink.text()).toBe('onetwo')
    expect(sink.truncated()).toBe(false)
  })

  it('decodes UTF-8 across every chunk boundary and byte limit', () => {
    const bytes = Buffer.from('a💻é\r\nb')
    for (let split = 0; split <= bytes.length; split += 1) {
      for (let cap = 0; cap <= bytes.length + 1; cap += 1) {
        const sink = createOutputSink(cap)
        sink.write(bytes.subarray(0, split))
        sink.write(bytes.subarray(split))
        expect(sink.text()).toBe(bytes.subarray(0, cap).toString('utf8'))
        expect(sink.truncated()).toBe(bytes.length > cap)
      }
    }
  })

  it('clips a single string chunk at the byte limit', () => {
    const sink = createOutputSink(3)
    sink.write('a💻')
    expect(sink.text()).toBe('a�')
    expect(sink.truncated()).toBe(true)
  })

  it('keeps a bounded tail across reads, string chunks, and oversized buffers', () => {
    const sink = createOutputSink(4, 'tail')
    expect(sink.buffer()).toEqual(Buffer.alloc(0))
    sink.write('abc')
    expect(sink.text()).toBe('abc')
    sink.write('def')
    const snapshot = sink.buffer()
    expect(snapshot).toEqual(Buffer.from('cdef'))
    snapshot.fill(0)
    expect(sink.text()).toBe('cdef')
    const oversized = Buffer.concat([Buffer.alloc(12 * 1024 * 1024), Buffer.from('tail')])
    sink.write(oversized)
    oversized.fill(0)
    expect(sink.buffer()).toEqual(Buffer.from('tail'))
    expect(sink.buffer().buffer.byteLength).toBeLessThanOrEqual(Buffer.poolSize)
    expect(sink.truncated()).toBe(true)
  })

  it('retains exactly the newest UTF-8 bytes across every chunk boundary and cap', () => {
    const bytes = Buffer.from('a💻é\r\nb')
    for (let split = 0; split <= bytes.length; split += 1) {
      for (let cap = 0; cap <= bytes.length + 1; cap += 1) {
        const sink = createOutputSink(cap, 'tail')
        sink.write(bytes.subarray(0, split))
        sink.write(bytes.subarray(split))
        expect(sink.buffer()).toEqual(bytes.subarray(Math.max(0, bytes.length - cap)))
        expect(sink.text()).toBe(bytes.subarray(Math.max(0, bytes.length - cap)).toString('utf8'))
        expect(sink.truncated()).toBe(bytes.length > cap)
      }
    }
  })
})
