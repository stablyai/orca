import { describe, expect, it } from 'vitest'
import {
  MessageType,
  HEADER_LENGTH,
  FrameDecoder,
  encodeHandshakeFrame,
  parseHandshakeMessage,
  type DecodedFrame
} from './protocol'

describe('handshake framing', () => {
  it('round-trips an orca-relay-handshake envelope through the existing framing', () => {
    const sent = encodeHandshakeFrame({
      type: 'orca-relay-handshake',
      version: '0.1.0+deadbeef'
    })
    expect(sent[0]).toBe(MessageType.Handshake)
    expect(sent.length).toBeGreaterThan(HEADER_LENGTH)

    const frames: DecodedFrame[] = []
    const decoder = new FrameDecoder((f) => frames.push(f))
    decoder.feed(sent)

    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe(MessageType.Handshake)
    const msg = parseHandshakeMessage(frames[0].payload)
    expect(msg).toEqual({ type: 'orca-relay-handshake', version: '0.1.0+deadbeef' })
  })

  it('round-trips an orca-relay-handshake-ok reply', () => {
    const sent = encodeHandshakeFrame({
      type: 'orca-relay-handshake-ok',
      version: '0.1.0+deadbeef'
    })
    const frames: DecodedFrame[] = []
    const decoder = new FrameDecoder((f) => frames.push(f))
    decoder.feed(sent)
    const msg = parseHandshakeMessage(frames[0].payload)
    expect(msg).toEqual({ type: 'orca-relay-handshake-ok', version: '0.1.0+deadbeef' })
  })

  it('round-trips an orca-relay-handshake-mismatch reply', () => {
    const sent = encodeHandshakeFrame({
      type: 'orca-relay-handshake-mismatch',
      expected: '0.1.0+aaa',
      got: '0.1.0+bbb'
    })
    const frames: DecodedFrame[] = []
    const decoder = new FrameDecoder((f) => frames.push(f))
    decoder.feed(sent)
    const msg = parseHandshakeMessage(frames[0].payload)
    expect(msg).toEqual({
      type: 'orca-relay-handshake-mismatch',
      expected: '0.1.0+aaa',
      got: '0.1.0+bbb'
    })
  })

  it('rejects payloads with unknown type', () => {
    const bogus = Buffer.from(JSON.stringify({ type: 'orca-something-else', version: 'x' }))
    expect(() => parseHandshakeMessage(bogus)).toThrow(/Unknown handshake type/)
  })

  it('handshake frames use a distinct MessageType from Regular and KeepAlive', () => {
    expect(MessageType.Handshake).not.toBe(MessageType.Regular)
    expect(MessageType.Handshake).not.toBe(MessageType.KeepAlive)
  })
})
