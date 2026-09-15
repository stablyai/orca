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

  // `type` is peer-supplied, so it can be an object whose String() conversion throws — which
  // replaced the one diagnostic this refusal exists to produce with a primitive-conversion error.
  it('still names the refusal when the peer type cannot be stringified', () => {
    const hostile = Buffer.from(JSON.stringify({ type: { toString: 1 } }))
    expect(() => parseHandshakeMessage(hostile)).toThrow(/Unknown handshake type: object/)
  })

  // The daemon logs the peer's version before any credential check, and `JSON.parse` can hand
  // back a value a template literal throws on. The parser is the one place every reader shares.
  it('rejects a version that is not a string on both arms that carry one', () => {
    for (const type of ['orca-relay-handshake', 'orca-relay-handshake-ok']) {
      for (const version of [{ toString: 1 }, 7, null, undefined, ['0.1.0']]) {
        const payload = Buffer.from(JSON.stringify({ type, version }))
        expect(
          () => parseHandshakeMessage(payload),
          `${type} version=${JSON.stringify(version)}`
        ).toThrow(/Handshake field version is not a string/)
      }
    }
  })

  it('rejects a mismatch reply whose expected or got is not a string', () => {
    const type = 'orca-relay-handshake-mismatch'
    expect(() =>
      parseHandshakeMessage(Buffer.from(JSON.stringify({ type, expected: {}, got: 'b' })))
    ).toThrow(/Handshake field expected is not a string/)
    expect(() =>
      parseHandshakeMessage(Buffer.from(JSON.stringify({ type, expected: 'a', got: 1 })))
    ).toThrow(/Handshake field got is not a string/)
  })

  it('rejects payloads that are not objects', () => {
    for (const payload of ['null', '"orca-relay-handshake"', '42']) {
      expect(() => parseHandshakeMessage(Buffer.from(payload)), payload).toThrow(
        /Handshake payload is not an object/
      )
    }
  })

  it('still accepts a credential-mismatch reply, which carries no fields', () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'orca-relay-handshake-credential-mismatch' })
    )
    expect(parseHandshakeMessage(payload)).toEqual({
      type: 'orca-relay-handshake-credential-mismatch'
    })
  })

  it('handshake frames use a distinct MessageType from Regular and KeepAlive', () => {
    expect(MessageType.Handshake).not.toBe(MessageType.Regular)
    expect(MessageType.Handshake).not.toBe(MessageType.KeepAlive)
  })
})
