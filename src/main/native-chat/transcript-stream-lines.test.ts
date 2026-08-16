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
