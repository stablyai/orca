import { describe, expect, it } from 'vitest'
import { encodeContentLengthMessage, ContentLengthMessageDecoder } from './content-length-framing'

function frame(message: unknown): Buffer {
  return encodeContentLengthMessage(message)
}

describe('encodeContentLengthMessage', () => {
  it('uses the utf8 byte length, not the string length', () => {
    const encoded = encodeContentLengthMessage({ text: 'héllo' }).toString('utf8')
    const body = encoded.slice(encoded.indexOf('\r\n\r\n') + 4)
    expect(encoded).toContain(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`)
  })
})

describe('ContentLengthMessageDecoder', () => {
  it('decodes a message split across arbitrary chunk boundaries', () => {
    const decoder = new ContentLengthMessageDecoder()
    const encoded = frame({ jsonrpc: '2.0', id: 1, result: { value: 'héllo' } })
    const out: unknown[] = []
    for (let i = 0; i < encoded.length; i += 3) {
      out.push(...decoder.push(encoded.subarray(i, i + 3)))
    }
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, result: { value: 'héllo' } }])
  })

  it('decodes multiple messages arriving in one chunk', () => {
    const decoder = new ContentLengthMessageDecoder()
    const chunk = Buffer.concat([frame({ id: 1 }), frame({ id: 2 }), frame({ id: 3 })])
    expect(decoder.push(chunk)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('tolerates extra headers like Content-Type', () => {
    const decoder = new ContentLengthMessageDecoder()
    const body = JSON.stringify({ id: 7 })
    const raw = Buffer.from(
      `Content-Length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`,
      'utf8'
    )
    expect(decoder.push(raw)).toEqual([{ id: 7 }])
  })

  it('skips a malformed body and keeps decoding subsequent messages', () => {
    const decoder = new ContentLengthMessageDecoder()
    const bad = Buffer.from('Content-Length: 3\r\n\r\n{{{', 'utf8')
    expect(decoder.push(Buffer.concat([bad, frame({ id: 2 })]))).toEqual([{ id: 2 }])
  })

  it('rejects a frame that declares an oversized body', () => {
    const decoder = new ContentLengthMessageDecoder()
    expect(() => decoder.push(Buffer.from('Content-Length: 999999999\r\n\r\n', 'utf8'))).toThrow(
      /size limit/
    )
  })
})
