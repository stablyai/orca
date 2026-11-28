import { describe, expect, it } from 'vitest'
import { RexStreamParser } from './rex-stream-parser'

describe('Rex terminal stream framing', () => {
  it('preserves UTF-8 and VT bytes across every split while separating nonce-qualified metadata', () => {
    const metadata = { type: 'resize', cols: 91, rows: 27 }
    const input = Buffer.from(`前😀\x1b_rex1;42;${JSON.stringify(metadata)}\x1b\\後_日本`)
    for (let split = 0; split <= input.length; split++) {
      let output = ''
      const events: unknown[] = []
      const parser = new RexStreamParser(
        42n,
        (text) => {
          output += text
        },
        (event) => events.push(event)
      )
      parser.feed(input.subarray(0, split))
      parser.feed(input.subarray(split))
      expect(output).toBe('前😀後_日本')
      expect(events).toEqual([metadata])
    }
  })

  it('does not reinterpret a different nonce as transport metadata', () => {
    const input = 'a\x1b_rex1;43;{"type":"resize"}\x1b\\b'
    let output = ''
    const events: unknown[] = []
    const parser = new RexStreamParser(
      42n,
      (text) => {
        output += text
      },
      (event) => events.push(event)
    )
    for (const byte of Buffer.from(input)) {
      parser.feed(Buffer.from([byte]))
    }
    expect(output).toBe(input)
    expect(events).toEqual([])
  })

  it('rejects an unterminated transport record above the bound', () => {
    const parser = new RexStreamParser(
      42n,
      () => {},
      () => {}
    )
    expect(() =>
      parser.feed(Buffer.concat([Buffer.from('\x1b_rex1;42;'), Buffer.alloc(1024 * 1024)]))
    ).toThrow('metadata too large')
  })

  it('rejects an oversized complete metadata frame before decoding, regardless of chunk boundaries', () => {
    const frame = Buffer.from(
      `\x1b_rex1;42;${JSON.stringify({ text: 'a'.repeat(1024 * 1024) })}\x1b\\`
    )
    for (const split of [0, frame.length - 1]) {
      const events: unknown[] = []
      const parser = new RexStreamParser(
        42n,
        () => {},
        (event) => events.push(event)
      )
      expect(() => {
        parser.feed(frame.subarray(0, split))
        parser.feed(frame.subarray(split))
      }).toThrow('metadata too large')
      expect(events).toEqual([])
    }
  })

  it('accepts a complete record exactly at the bound and treats its following bytes as output', () => {
    const prefix = '\x1b_rex1;42;'
    const suffix = '\x1b\\'
    const overhead = Buffer.byteLength(prefix + JSON.stringify({ text: '' }) + suffix)
    const event = { text: 'a'.repeat(1024 * 1024 - overhead) }
    const frame = Buffer.from(prefix + JSON.stringify(event) + suffix)
    expect(frame.length).toBe(1024 * 1024)
    const events: unknown[] = []
    let output = ''
    const parser = new RexStreamParser(
      42n,
      (text) => {
        output += text
      },
      (value) => events.push(value)
    )
    parser.feed(Buffer.concat([frame, Buffer.from('ordinary output')]))
    expect(events).toEqual([event])
    expect(output).toBe('ordinary output')
  })

  it('does not retain a large consumed frame behind an empty or partial record', () => {
    const prefix = Buffer.from('\x1b_rex1;42;')
    const metadata = Buffer.from('{"type":"resize"}\x1b\\')
    for (const tail of [Buffer.alloc(0), prefix.subarray(0, 5), prefix]) {
      let outputBytes = 0
      const events: unknown[] = []
      const parser = new RexStreamParser(
        42n,
        (text) => {
          outputBytes += text.length
        },
        (event) => events.push(event)
      )
      parser.feed(Buffer.concat([Buffer.alloc(4 * 1024 * 1024, 65), tail]))
      expect(outputBytes).toBe(4 * 1024 * 1024)
      expect(parser['pending'].length).toBe(tail.length)
      // Small buffers can use Node's pool, but must not pin the 4 MiB input.
      expect(parser['pending'].buffer.byteLength).toBeLessThanOrEqual(Buffer.poolSize)
      if (tail.length) {
        parser.feed(Buffer.concat([prefix.subarray(tail.length), metadata]))
        expect(events).toEqual([{ type: 'resize' }])
      }
    }
  })
})
