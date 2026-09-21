import { describe, expect, it, vi } from 'vitest'
import {
  encodeNdjson,
  createNdjsonParser,
  NDJSON_MAX_LINE_BYTES,
  NdjsonLineTooLongError
} from './ndjson'
import { createIncrementalNdjsonFramer } from '../../shared/main-process-ndjson-framer'

describe('encodeNdjson', () => {
  it('encodes an object as a JSON line ending with newline', () => {
    const result = encodeNdjson({ type: 'hello', version: 1 })
    expect(result).toBe('{"type":"hello","version":1}\n')
  })

  it('encodes nested objects', () => {
    const msg = { id: 'req-1', type: 'write', payload: { sessionId: 'abc', data: 'ls\n' } }
    const result = encodeNdjson(msg)
    expect(result.endsWith('\n')).toBe(true)
    expect(JSON.parse(result.trim())).toEqual(msg)
  })

  it('accepts the exact line-byte limit and rejects one byte more', () => {
    const emptyBytes = Buffer.byteLength(JSON.stringify({ data: '' }), 'utf8')
    expect(encodeNdjson({ data: 'abc' }, emptyBytes + 3)).toBe('{"data":"abc"}\n')
    expect(() => encodeNdjson({ data: 'abcd' }, emptyBytes + 3)).toThrow(NdjsonLineTooLongError)
  })

  // Why: the cap is UTF-8 bytes, not characters — a code-unit count would let a 4-byte emoji slip past.
  it('measures multibyte payloads in UTF-8 bytes, not characters', () => {
    const emptyBytes = Buffer.byteLength(JSON.stringify({ data: '' }), 'utf8')
    expect(encodeNdjson({ data: '🐙' }, emptyBytes + 4)).toBe('{"data":"🐙"}\n')
    expect(() => encodeNdjson({ data: '🐙' }, emptyBytes + 3)).toThrow(NdjsonLineTooLongError)
    expect(() => encodeNdjson({ data: 'é' }, emptyBytes + 1)).toThrow(NdjsonLineTooLongError)
  })
})

describe('createNdjsonParser', () => {
  it('exports a bounded default line size', () => {
    expect(NDJSON_MAX_LINE_BYTES).toBe(16 * 1024 * 1024)
  })

  it('parses a single complete message', () => {
    const onMessage = vi.fn()
    const onError = vi.fn()
    const parser = createNdjsonParser(onMessage, onError)

    parser.feed('{"type":"hello"}\n')

    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledWith({ type: 'hello' })
    expect(onError).not.toHaveBeenCalled()
  })

  it('parses multiple messages in a single chunk', () => {
    const onMessage = vi.fn()
    const parser = createNdjsonParser(onMessage)

    parser.feed('{"a":1}\n{"b":2}\n{"c":3}\n')

    expect(onMessage).toHaveBeenCalledTimes(3)
    expect(onMessage).toHaveBeenNthCalledWith(1, { a: 1 })
    expect(onMessage).toHaveBeenNthCalledWith(2, { b: 2 })
    expect(onMessage).toHaveBeenNthCalledWith(3, { c: 3 })
  })

  it('handles messages split across multiple chunks', () => {
    const onMessage = vi.fn()
    const parser = createNdjsonParser(onMessage)

    parser.feed('{"type":"hel')
    expect(onMessage).not.toHaveBeenCalled()

    parser.feed('lo","version":1}\n')
    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledWith({ type: 'hello', version: 1 })
  })

  it('handles a chunk that ends mid-line followed by more data', () => {
    const onMessage = vi.fn()
    const parser = createNdjsonParser(onMessage)

    parser.feed('{"id":"1"}\n{"id":')
    expect(onMessage).toHaveBeenCalledOnce()

    parser.feed('"2"}\n')
    expect(onMessage).toHaveBeenCalledTimes(2)
    expect(onMessage).toHaveBeenNthCalledWith(2, { id: '2' })
  })

  it('ignores empty lines', () => {
    const onMessage = vi.fn()
    const parser = createNdjsonParser(onMessage)

    parser.feed('\n\n{"ok":true}\n\n')

    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledWith({ ok: true })
  })

  it('calls onError for malformed JSON', () => {
    const onMessage = vi.fn()
    const onError = vi.fn()
    const parser = createNdjsonParser(onMessage, onError)

    parser.feed('not json\n')

    expect(onMessage).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
  })

  it('recovers after malformed JSON and parses next line', () => {
    const onMessage = vi.fn()
    const onError = vi.fn()
    const parser = createNdjsonParser(onMessage, onError)

    parser.feed('bad\n{"good":true}\n')

    expect(onError).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledWith({ good: true })
  })

  it('drops oversized complete lines and parses following messages', () => {
    const onMessage = vi.fn()
    const onError = vi.fn()
    const parser = createNdjsonParser(onMessage, onError, { maxLineBytes: 24 })

    parser.feed(`${'x'.repeat(25)}\n{"good":true}\n`)

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].message).toContain('NDJSON line exceeds max 24 bytes')
    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledWith({ good: true })
  })

  it('discards oversized partial lines until the next delimiter', () => {
    const onMessage = vi.fn()
    const onError = vi.fn()
    const parser = createNdjsonParser(onMessage, onError, { maxLineBytes: 24 })

    parser.feed('{"too":')
    parser.feed(`"${'x'.repeat(24)}"}`)
    parser.feed('\n{"fresh":true}\n')

    expect(onError).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledWith({ fresh: true })
  })

  it('handles messages with embedded newlines in strings', () => {
    const onMessage = vi.fn()
    const parser = createNdjsonParser(onMessage)

    // JSON.stringify escapes newlines as \n (two chars), so the actual
    // newline delimiter is still unambiguous.
    const msg = { data: 'line1\nline2' }
    parser.feed(`${JSON.stringify(msg)}\n`)

    expect(onMessage).toHaveBeenCalledWith(msg)
  })

  it('resets buffer state on reset()', () => {
    const onMessage = vi.fn()
    const parser = createNdjsonParser(onMessage)

    parser.feed('{"partial":')
    parser.reset()
    parser.feed('{"fresh":true}\n')

    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledWith({ fresh: true })
  })

  it('retains a valid suffix when paused input overflows after an oversized partial line', () => {
    const records: unknown[] = []
    const rejected: unknown[] = []
    let paused = true
    const framer = createIncrementalNdjsonFramer(
      (record) => records.push(record),
      (error) => rejected.push(error),
      { maxLineBytes: 32, shouldPause: () => paused }
    )

    // The first record leaves a partial line in the paused remainder.
    framer.feed('{}\nx')
    framer.feed(`${'y'.repeat(70_000)}\n{"good":true}\n`)

    paused = false
    framer.resume()

    expect(rejected).toHaveLength(1)
    expect(records).toEqual([{}, { good: true }])
  })

  it('queues many complete records while paused without treating them as one oversized suffix', () => {
    const records: unknown[] = []
    let paused = true
    const framer = createIncrementalNdjsonFramer(
      (record) => records.push(record),
      () => {
        throw new Error('complete records should not be rejected')
      },
      { shouldPause: () => paused }
    )
    const count = 100_000
    framer.feed(`${JSON.stringify({ index: 0 })}\n`)
    framer.feed(
      Array.from({ length: count }, (_, index) => `${JSON.stringify({ index: index + 1 })}\n`).join(
        ''
      )
    )

    paused = false
    framer.resume()

    expect(records).toHaveLength(count + 1)
    expect(records.at(-1)).toEqual({ index: count })
  })

  it('does not drop data fed after queued records when the consumer resumes', () => {
    const records: unknown[] = []
    let paused = true
    const framer = createIncrementalNdjsonFramer(
      (record) => records.push(record),
      (error) => {
        throw error
      },
      { shouldPause: () => paused }
    )

    framer.feed('{"queued":true}\n')
    paused = false
    framer.feed('{"after":true}\n')

    expect(records).toEqual([{ queued: true }, { after: true }])
  })

  it('does not dispatch a pending suffix ahead of queued records after re-pause', () => {
    const records: unknown[] = []
    let paused = true
    const framer = createIncrementalNdjsonFramer(
      (record) => {
        records.push(record)
        if ((record as { index?: number }).index === 1) {
          paused = true
        }
      },
      (error) => {
        throw new Error(`unexpected rejection: ${JSON.stringify(error)}`)
      },
      { shouldPause: () => paused }
    )

    framer.feed('{"index":0}\n{"index":1}\n{"index":2}\n{"index":')
    paused = false
    framer.resume()

    expect(records).toEqual([{ index: 0 }, { index: 1 }])
    paused = false
    framer.resume()
    expect(records).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }])

    framer.feed('3}\n')
    expect(records).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }])
  })

  it('caps an actually incomplete paused suffix and recovers at the next delimiter', () => {
    const records: unknown[] = []
    const rejected: unknown[] = []
    let paused = true
    const framer = createIncrementalNdjsonFramer(
      (record) => records.push(record),
      (error) => rejected.push(error),
      { maxLineBytes: 32, shouldPause: () => paused }
    )

    framer.feed('{}\nx')
    framer.feed('y'.repeat(70_000))
    paused = false
    framer.resume()
    framer.feed('\n{"recovered":true}\n')

    expect(rejected).toHaveLength(1)
    expect(records).toEqual([{}, { recovered: true }])
  })
})
