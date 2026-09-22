import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { decodeTranscriptStream, splitTranscriptStreamLines } from './transcript-stream-lines'

const decode = (line: string, id: string) => ({
  id,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: line }],
  timestamp: null,
  source: 'transcript' as const
})

describe('decodeTranscriptStream', () => {
  it('accepts the exact source limit with split UTF-8 bytes and preserves order', async () => {
    const bytes = Buffer.from('é\n😀\n')
    const result = await decodeTranscriptStream(
      Readable.from([bytes.subarray(0, 1), bytes.subarray(1, 5), bytes.subarray(5)]),
      '/chat.jsonl',
      0,
      decode,
      true,
      bytes.length
    )
    expect(result.messages.map((message) => message.blocks[0])).toEqual([
      { type: 'text', text: 'é' },
      { type: 'text', text: '😀' }
    ])
  })

  it.each([Buffer.from('é'), 'é', Buffer.from([0xff, 0xff])])(
    'counts source bytes before decoding an oversized chunk %j',
    async (chunk) => {
      const stream = Readable.from([chunk])
      const trackedDecode = vi.fn(decode)
      await expect(
        decodeTranscriptStream(stream, '/chat.jsonl', 0, trackedDecode, true, 1)
      ).rejects.toThrow('exceeds 1 byte limit')
      expect(trackedDecode).not.toHaveBeenCalled()
      expect(stream.destroyed).toBe(true)
    }
  )

  it.each([true, false])('preserves chunked record offsets with trailing=%s', async (trailing) => {
    const first = `${'long record '.repeat(10_000)}😀`
    const prefix = `\r\n${first}\r\n\n`
    const partial = 'unfinished é'
    const bytes = Buffer.from(prefix + partial)
    const chunks: Buffer[] = []
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      chunks.push(bytes.subarray(offset, offset + 1024))
    }
    const result = await decodeTranscriptStream(
      Readable.from(chunks),
      '/chat.jsonl',
      100,
      decode,
      trailing
    )
    expect(result.messages.map((message) => message.blocks[0])).toEqual([
      { type: 'text', text: first },
      ...(trailing ? [{ type: 'text', text: partial }] : [])
    ])
    expect(result.messages[0]?.id).toBe('/chat.jsonl:0000000000000102')
    expect(result.consumedBytes).toBe(trailing ? bytes.length : Buffer.byteLength(prefix))
  })

  it('searches each chunk once when a line spans many chunks', async () => {
    const input = `${'x'.repeat(256 * 1024)}\n`
    const chunks: string[] = []
    for (let offset = 0; offset < input.length; offset += 4096) {
      chunks.push(input.slice(offset, offset + 4096))
    }
    let searchedCharacters = 0
    const originalIndexOf = String.prototype.indexOf
    const spy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      this: string,
      search: string,
      position?: number
    ) {
      const found = originalIndexOf.call(this, search, position)
      if (search === '\n') {
        searchedCharacters += (found < 0 ? this.length : found + 1) - (position ?? 0)
      }
      return found
    })
    let result
    try {
      result = await decodeTranscriptStream(Readable.from(chunks), '/chat.jsonl', 0, decode, true)
    } finally {
      spy.mockRestore()
    }
    expect(result.messages[0]?.blocks[0]).toEqual({ type: 'text', text: input.slice(0, -1) })
    expect(result.consumedBytes).toBe(input.length)
    expect(searchedCharacters).toBeLessThanOrEqual(input.length * 2)
  })

  it('joins split UTF-16 surrogate pairs before deriving byte offsets', async () => {
    const chunks = ['a\ud83d', '\ude00', '\r', '\n\n', 'tail\r']
    const actual = await decodeTranscriptStream(
      Readable.from(chunks),
      '/chat.jsonl',
      123,
      decode,
      true
    )
    const expected = await decodeTranscriptStream(
      Readable.from([chunks.join('')]),
      '/chat.jsonl',
      123,
      decode,
      true
    )
    expect(actual).toEqual(expected)
    expect(actual.messages).toHaveLength(2)
    expect(actual.consumedBytes).toBe(Buffer.byteLength(chunks.join('')))
  })

  it.each([false, true])(
    'preserves decoder tail handling with includeTrailingLine=%s',
    async (includeTrailingLine) => {
      const chunks = [Buffer.from('line\r\n'), Buffer.from([0xf0, 0x9f])]
      const actual = await decodeTranscriptStream(
        Readable.from(chunks),
        '/chat.jsonl',
        20,
        decode,
        includeTrailingLine
      )
      expect(actual.messages.map((message) => message.blocks[0])).toEqual([
        { type: 'text', text: 'line' },
        ...(includeTrailingLine ? [{ type: 'text', text: '\ufffd' }] : [])
      ])
      expect(actual.consumedBytes).toBe(6 + (includeTrailingLine ? 3 : 0))
    }
  )

  it('closes the source when a decoder throws', async () => {
    const error = new Error('decode failed')
    const stream = Readable.from(['partial', ' line\nsecond\n'])
    const failingDecode = vi.fn(() => {
      throw error
    })
    await expect(
      decodeTranscriptStream(stream, '/chat.jsonl', 0, failingDecode, true)
    ).rejects.toBe(error)
    expect(failingDecode).toHaveBeenCalledOnce()
    expect(stream.destroyed).toBe(true)
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

  it('keeps a codepoint split across two Buffer chunks intact', async () => {
    const line = `{"text":"😀é中"}\n`
    const bytes = Buffer.from(line, 'utf8')
    // Split inside the emoji's 4-byte sequence, as a 1 MiB gated chunk boundary does.
    const split = Buffer.from('{"text":"', 'utf8').length + 2
    const result = await decodeTranscriptStream(
      Readable.from([bytes.subarray(0, split), bytes.subarray(split)]),
      '/chat.jsonl',
      0,
      decode,
      false
    )

    expect(result.messages[0]?.blocks[0]).toEqual({ type: 'text', text: line.slice(0, -1) })
    expect(result.consumedBytes).toBe(bytes.length)
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

describe('bounded transcript records', () => {
  async function collect(chunks: (Buffer | string)[], limit: number) {
    const records: string[] = []
    for await (const record of splitTranscriptStreamLines(Readable.from(chunks), limit)) {
      records.push(record.line)
    }
    return records
  }

  it.each(['', '\n', '\nnext\n'])('rejects an oversized record ending in %j', async (ending) => {
    await expect(collect(['1234', `5${ending}`], 4)).rejects.toThrow('record exceeds 4 byte limit')
    await expect(collect([`12345${ending}`], 4)).rejects.toThrow('record exceeds 4 byte limit')
  })

  it('resets the byte budget per record and accepts the exact limit', async () => {
    expect(await collect(['1234\n123', '4\n1234'], 4)).toEqual(['1234', '1234', '1234'])
  })

  it('counts UTF-8 bytes across split codepoints', async () => {
    const bytes = Buffer.from('😀é')
    const chunks = [bytes.subarray(0, 2), bytes.subarray(2, 5), bytes.subarray(5)]
    expect((await collect(chunks, 6))[0]).toBe('😀é')
    await expect(collect(chunks, 5)).rejects.toThrow('record exceeds 5 byte limit')
    expect((await collect(['\ud83d', '\ude00'], 4))[0]).toBe('😀')
  })

  it('checks the decoder tail before emitting it', async () => {
    await expect(collect([Buffer.from([0x61, 0xf0, 0x9f])], 3)).rejects.toThrow(
      'record exceeds 3 byte limit'
    )
  })
})
