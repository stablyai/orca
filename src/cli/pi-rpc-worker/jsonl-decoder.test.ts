import { describe, expect, it, vi } from 'vitest'
import { StrictJsonlDecoder } from './jsonl-decoder'

function encoded(value: string): Buffer {
  return Buffer.from(value, 'utf8')
}

describe('StrictJsonlDecoder', () => {
  it('decodes records across every byte boundary', () => {
    const records: Record<string, unknown>[] = []
    const decoder = new StrictJsonlDecoder((record) => records.push(record))
    const bytes = encoded('{"type":"message","text":"привет"}\n')
    for (const byte of bytes) {
      decoder.push(Uint8Array.of(byte))
    }
    decoder.finish()
    expect(records).toEqual([{ type: 'message', text: 'привет' }])
  })

  it('accepts one terminal CR while preserving Unicode line separators', () => {
    const record = vi.fn()
    const decoder = new StrictJsonlDecoder(record)
    decoder.push(encoded('{"text":"a b c"}\r\n'))
    decoder.finish()
    expect(record).toHaveBeenCalledWith({ text: 'a b c' })
  })

  it('enforces the line limit in bytes', () => {
    const line = encoded('{"x":"é"}')
    const accepted = new StrictJsonlDecoder(() => {}, line.byteLength)
    accepted.push(Buffer.concat([line, encoded('\n')]))
    accepted.finish()

    const rejected = new StrictJsonlDecoder(() => {}, line.byteLength - 1)
    expect(() => rejected.push(Buffer.concat([line, encoded('\n')]))).toThrow('inbound byte limit')
  })

  it('rejects invalid UTF-8, malformed JSON, and empty records', () => {
    const utf8 = new StrictJsonlDecoder(() => {})
    expect(() => utf8.push(Buffer.from([0xc3, 0x28, 0x0a]))).toThrow('invalid UTF-8')

    const malformed = new StrictJsonlDecoder(() => {})
    expect(() => malformed.push(encoded('{no}\n'))).toThrow('malformed JSON')

    const empty = new StrictJsonlDecoder(() => {})
    expect(() => empty.push(encoded('\n'))).toThrow('empty JSONL')
  })

  it('fails closed on an unterminated EOF record', () => {
    const decoder = new StrictJsonlDecoder(() => {})
    decoder.push(encoded('{"type":"agent_settled"}'))
    expect(() => decoder.finish()).toThrow('unterminated JSONL')
  })
})
