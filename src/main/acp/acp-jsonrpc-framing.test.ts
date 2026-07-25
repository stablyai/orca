import { describe, expect, it, vi } from 'vitest'
import { ACP_MAX_LINE_BYTES, createAcpLineDecoder, encodeAcpMessage } from './acp-jsonrpc-framing'

describe('createAcpLineDecoder', () => {
  it('decodes one message per line', () => {
    const decoder = createAcpLineDecoder()
    const messages = decoder.push('{"jsonrpc":"2.0","id":1,"result":{}}\n{"method":"x"}\n')
    expect(messages).toHaveLength(2)
    expect(messages[0].id).toBe(1)
    expect(messages[1].method).toBe('x')
  })

  it('reassembles a message split across chunks', () => {
    const decoder = createAcpLineDecoder()
    expect(decoder.push('{"jsonrpc":"2.0",')).toEqual([])
    expect(decoder.push('"id":7,"result":')).toEqual([])
    const done = decoder.push('{"ok":true}}\n')
    expect(done).toHaveLength(1)
    expect(done[0].id).toBe(7)
  })

  it('holds a partial trailing line until its newline arrives', () => {
    const decoder = createAcpLineDecoder()
    expect(decoder.push('{"method":"a"}\n{"method":"b"}')).toHaveLength(1)
    expect(decoder.pending()).toBeGreaterThan(0)
    expect(decoder.push('\n')).toHaveLength(1)
    expect(decoder.pending()).toBe(0)
  })

  it('skips blank lines', () => {
    const decoder = createAcpLineDecoder()
    expect(decoder.push('\n\n{"method":"a"}\n\n')).toHaveLength(1)
  })

  it('reports malformed JSON without throwing, and keeps decoding', () => {
    const onMalformed = vi.fn()
    const decoder = createAcpLineDecoder(onMalformed)
    const messages = decoder.push('not json\n{"method":"a"}\n')
    expect(onMalformed).toHaveBeenCalledTimes(1)
    expect(messages).toHaveLength(1)
    expect(messages[0].method).toBe('a')
  })

  it('rejects a non-object frame (array / bare scalar)', () => {
    const onMalformed = vi.fn()
    const decoder = createAcpLineDecoder(onMalformed)
    expect(decoder.push('[1,2]\n"banner"\n')).toEqual([])
    expect(onMalformed).toHaveBeenCalledTimes(2)
  })

  it('drops an oversized unterminated frame instead of buffering forever', () => {
    const onMalformed = vi.fn()
    const decoder = createAcpLineDecoder(onMalformed)
    expect(decoder.push('x'.repeat(ACP_MAX_LINE_BYTES + 1))).toEqual([])
    expect(onMalformed).toHaveBeenCalledTimes(1)
    expect(decoder.pending()).toBe(0)
  })

  it('round-trips through encodeAcpMessage', () => {
    const decoder = createAcpLineDecoder()
    const encoded = encodeAcpMessage({ jsonrpc: '2.0', id: 3, method: 'initialize' })
    expect(encoded.endsWith('\n')).toBe(true)
    expect(decoder.push(encoded)[0].method).toBe('initialize')
  })
})
