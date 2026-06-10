import { describe, it, expect } from 'vitest'
import { NdjsonParser } from './ndjson-parser'

describe('NdjsonParser', () => {
  it('parses a complete single line', () => {
    const p = new NdjsonParser()
    const evts = p.push('{"type":"system","subtype":"init","session_id":"s1"}\n')
    expect(evts).toHaveLength(1)
    expect(evts[0]).toMatchObject({ type: 'system', session_id: 's1' })
  })

  it('buffers a line split across two chunks', () => {
    const p = new NdjsonParser()
    expect(p.push('{"type":"assist')).toEqual([])
    const evts = p.push('ant","message":{"role":"assistant","content":[]}}\n')
    expect(evts).toHaveLength(1)
    expect(evts[0]).toMatchObject({ type: 'assistant' })
  })

  it('parses multiple lines in one chunk', () => {
    const p = new NdjsonParser()
    const evts = p.push('{"type":"a"}\n{"type":"b"}\n')
    expect(evts.map((e: unknown) => (e as { type: string }).type)).toEqual(['a', 'b'])
  })

  it('skips blank lines and tolerates malformed JSON without throwing', () => {
    const p = new NdjsonParser()
    const evts = p.push('\n{bad json}\n{"type":"ok"}\n')
    expect(evts).toHaveLength(1)
    expect(evts[0]).toMatchObject({ type: 'ok' })
  })

  it('flush() returns a final buffered line without trailing newline', () => {
    const p = new NdjsonParser()
    p.push('{"type":"partial"')
    expect(p.flush()).toEqual([]) // incomplete JSON -> nothing
    const p2 = new NdjsonParser()
    p2.push('{"type":"done"}')
    expect(p2.flush()).toEqual([{ type: 'done' }])
  })
})
