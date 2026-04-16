import { describe, expect, it, vi } from 'vitest'
import { encodeNdjson, createNdjsonParser } from './ndjson'

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
})

describe('createNdjsonParser', () => {
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
})
