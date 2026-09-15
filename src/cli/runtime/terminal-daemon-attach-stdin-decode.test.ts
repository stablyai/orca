import { StringDecoder } from 'node:string_decoder'
import { describe, expect, it } from 'vitest'
import { decodeStdinChunk } from './terminal-daemon-attach'

const CTRL_BACKSLASH = 0x1c
const Q = 0x71

describe('decodeStdinChunk', () => {
  it('reassembles a CJK character split across two stdin chunks', () => {
    const decoder = new StringDecoder('utf8')
    const bytes = Buffer.from('好')
    const first = decodeStdinChunk(decoder, bytes.subarray(0, 1), false)
    expect(first.data).toBe('')
    const second = decodeStdinChunk(decoder, bytes.subarray(1), false)
    expect(second.data).toBe('好')
    expect(second.data).not.toContain('�')
  })

  it('reassembles an emoji split mid-codepoint alongside surrounding text', () => {
    const decoder = new StringDecoder('utf8')
    const bytes = Buffer.from('ab😀cd')
    const first = decodeStdinChunk(decoder, bytes.subarray(0, 4), false)
    const second = decodeStdinChunk(decoder, bytes.subarray(4), false)
    expect(first.data + second.data).toBe('ab😀cd')
  })

  it('forwards ordinary text unchanged', () => {
    const decoder = new StringDecoder('utf8')
    const r = decodeStdinChunk(decoder, Buffer.from('ls\r'), false)
    expect(r.data).toBe('ls\r')
    expect(r.detached).toBe(false)
    expect(r.prefixPending).toBe(false)
  })

  it('detaches on Ctrl-\\ then q without decoding those bytes', () => {
    const decoder = new StringDecoder('utf8')
    const r = decodeStdinChunk(decoder, Buffer.from([CTRL_BACKSLASH, Q]), false)
    expect(r.detached).toBe(true)
    expect(r.data).toBe('')
  })
})
