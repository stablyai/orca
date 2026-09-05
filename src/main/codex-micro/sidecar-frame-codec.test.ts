import { describe, expect, it } from 'vitest'
import {
  CODEX_MICRO_MAX_FRAME_BYTES,
  CodexMicroFrameDecoder,
  encodeCodexMicroFrame
} from './sidecar-frame-codec'

describe('encodeCodexMicroFrame', () => {
  it('prefixes the JSON body with a 4-byte big-endian length and stamps version 1', () => {
    const frame = encodeCodexMicroFrame({ type: 'release' })
    const len = frame.readUInt32BE(0)
    const body = JSON.parse(frame.subarray(4, 4 + len).toString('utf8'))
    expect(len).toBe(frame.byteLength - 4)
    expect(body).toEqual({ version: 1, type: 'release' })
  })

  it('throws rather than emit a frame over the 64 KiB cap', () => {
    const huge = { type: 'output_snapshot', rgbcfg: 'x'.repeat(CODEX_MICRO_MAX_FRAME_BYTES) }
    expect(() => encodeCodexMicroFrame(huge)).toThrow()
  })
})

describe('CodexMicroFrameDecoder', () => {
  it('decodes a single frame delivered in one chunk', () => {
    const decoder = new CodexMicroFrameDecoder()
    const frame = encodeCodexMicroFrame({ type: 'handshake' })
    const results = decoder.push(frame)
    expect(results).toEqual([{ ok: true, value: { version: 1, type: 'handshake' } }])
  })

  it('reassembles a frame split across multiple stdout chunks', () => {
    const decoder = new CodexMicroFrameDecoder()
    const frame = encodeCodexMicroFrame({ type: 'handshake' })
    const first = decoder.push(frame.subarray(0, 3))
    expect(first).toEqual([])
    const second = decoder.push(frame.subarray(3))
    expect(second).toEqual([{ ok: true, value: { version: 1, type: 'handshake' } }])
  })

  it('decodes multiple frames delivered in a single chunk', () => {
    const decoder = new CodexMicroFrameDecoder()
    const combined = Buffer.concat([
      encodeCodexMicroFrame({ type: 'handshake' }),
      encodeCodexMicroFrame({ type: 'release' })
    ])
    const results = decoder.push(combined)
    expect(results).toEqual([
      { ok: true, value: { version: 1, type: 'handshake' } },
      { ok: true, value: { version: 1, type: 'release' } }
    ])
  })

  it('fails closed on a declared length over the 64 KiB cap without buffering the payload', () => {
    const decoder = new CodexMicroFrameDecoder()
    const header = Buffer.alloc(4)
    header.writeUInt32BE(CODEX_MICRO_MAX_FRAME_BYTES + 1, 0)
    const results = decoder.push(header)
    expect(results).toEqual([{ ok: false, reason: 'frame-too-large' }])
  })

  it('fails closed on malformed JSON', () => {
    const decoder = new CodexMicroFrameDecoder()
    const body = Buffer.from('not json', 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.byteLength, 0)
    const results = decoder.push(Buffer.concat([header, body]))
    expect(results).toEqual([{ ok: false, reason: 'malformed' }])
  })

  it('fails closed on an unsupported protocol version', () => {
    const decoder = new CodexMicroFrameDecoder()
    const body = Buffer.from(JSON.stringify({ version: 99, type: 'handshake' }), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.byteLength, 0)
    const results = decoder.push(Buffer.concat([header, body]))
    expect(results).toEqual([{ ok: false, reason: 'unsupported-version' }])
  })
})
