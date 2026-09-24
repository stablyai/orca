import { StringDecoder } from 'node:string_decoder'
import { describe, expect, it } from 'vitest'
import { createNdjsonParser, encodeNdjson } from '../../shared/main-process-ndjson-framer'

// Guards the socket-read decode contract in terminal-daemon-socket.ts: a multibyte
// UTF-8 sequence split across two socket chunks must round-trip, not become U+FFFD.
describe('daemon socket NDJSON UTF-8 decoding', () => {
  it('reassembles a multibyte sequence split across chunks (StringDecoder path)', () => {
    const messages: unknown[] = []
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (msg) => messages.push(msg),
      () => {}
    )
    // A CJK char (3 bytes) and an emoji (4 bytes) inside a JSON line.
    const line = Buffer.from(encodeNdjson({ data: '数🐳' }), 'utf8')
    // Split mid-codepoint at several boundaries.
    for (let cut = 1; cut < line.length; cut += 3) {
      parser.feed(decoder.write(line.subarray(0, cut)))
      parser.feed(decoder.write(line.subarray(cut)))
      const last = messages.pop() as { data: string }
      expect(last.data).toBe('数🐳')
      expect(last.data).not.toContain('�')
    }
  })

  it('per-chunk toString would corrupt — sanity check of the failure mode', () => {
    // The old code path: decoding each chunk independently yields replacement chars.
    // Split at the exact middle of the 4-byte emoji so the cut lands inside it.
    const emoji = Buffer.from('🐳', 'utf8') // 4 bytes
    const head = Buffer.concat([Buffer.from('{"data":"', 'utf8'), emoji.subarray(0, 2)])
    const tail = Buffer.concat([emoji.subarray(2), Buffer.from('"}', 'utf8')])
    const naive = head.toString('utf8') + tail.toString('utf8')
    expect(naive).toContain('�')
  })
})
