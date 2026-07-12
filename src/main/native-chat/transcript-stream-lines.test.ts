import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { decodeTranscriptStream } from './transcript-stream-lines'

const decode = (line: string, id: string) => ({
  id,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: line }],
  timestamp: null,
  source: 'transcript' as const
})

describe('decodeTranscriptStream', () => {
  it.each([
    ['emoji', '🙂', 2],
    ['CJK character', '汉', 1]
  ])('preserves a split %s across buffer chunks', async (_name, character, splitOffset) => {
    const prefix = '{"value":"'
    const line = `${prefix}${character}"}`
    const encoded = Buffer.from(`${line}\n`, 'utf8')
    const splitIndex = Buffer.byteLength(prefix, 'utf8') + splitOffset

    const result = await decodeTranscriptStream(
      Readable.from([encoded.subarray(0, splitIndex), encoded.subarray(splitIndex)]),
      '/chat.jsonl',
      0,
      decode,
      true,
      { maxDecodedBytes: encoded.length, maxLineBytes: Buffer.byteLength(line, 'utf8') }
    )

    expect(result.messages[0]?.blocks).toEqual([{ type: 'text', text: line }])
    expect(result.consumedBytes).toBe(encoded.length)
  })

  it('flushes an incomplete UTF-8 tail without advancing past its raw bytes', async () => {
    const encoded = Buffer.concat([Buffer.from('partial:'), Buffer.from([0xf0, 0x9f])])

    const result = await decodeTranscriptStream(
      Readable.from([encoded]),
      '/chat.jsonl',
      0,
      decode,
      true
    )

    expect(result.messages[0]?.blocks).toEqual([{ type: 'text', text: 'partial:\uFFFD' }])
    expect(result.consumedBytes).toBe(encoded.length)
  })

  it('uses raw byte offsets after malformed UTF-8 before a partial next line', async () => {
    const complete = Buffer.from([0xff, 0x0a])
    const partial = Buffer.from('x')

    const result = await decodeTranscriptStream(
      Readable.from([complete, partial]),
      '/chat.jsonl',
      0,
      decode,
      false
    )

    expect(result.messages[0]?.blocks).toEqual([{ type: 'text', text: '\uFFFD' }])
    expect(result.consumedBytes).toBe(complete.length)
  })

  it('preserves a surrogate pair split across string chunks', async () => {
    const line = '{"value":"🙂"}'

    const result = await decodeTranscriptStream(
      Readable.from(['{"value":"\ud83d', '\ude42"}\n']),
      '/chat.jsonl',
      0,
      decode,
      true
    )

    expect(result.messages[0]?.blocks).toEqual([{ type: 'text', text: line }])
    expect(result.consumedBytes).toBe(Buffer.byteLength(`${line}\n`, 'utf8'))
  })

  it('uses identical absolute byte ids for full and incremental reads', async () => {
    const prefix = '{"first":"é"}\r\n'
    const appended = '{"second":true}\n'
    const full = await decodeTranscriptStream(
      Readable.from([prefix + appended]),
      '/chat.jsonl',
      0,
      decode,
      true
    )
    const incremental = await decodeTranscriptStream(
      Readable.from([appended]),
      '/chat.jsonl',
      Buffer.byteLength(prefix, 'utf8'),
      decode,
      false
    )

    expect(incremental.messages[0]?.id).toBe(full.messages[1]?.id)
  })

  it('does not consume a partial trailing JSONL record', async () => {
    const complete = '{"first":true}\n'
    const partial = '{"second"'
    const result = await decodeTranscriptStream(
      Readable.from([complete + partial]),
      '/chat.jsonl',
      0,
      decode,
      false
    )

    expect(result.messages).toHaveLength(1)
    expect(result.consumedBytes).toBe(Buffer.byteLength(complete, 'utf8'))
  })
})
