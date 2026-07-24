import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { transcriptFallbackId } from './transcript-fallback-id'
import { decodeTranscriptStream } from './transcript-stream-lines'
import { MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES } from './transcript-tail-reader'

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

  it('preserves multibyte UTF-8 split across one-byte stream chunks', async () => {
    const line = `prefix-😀-suffix`
    const encoded = Buffer.from(`${line}\n`)
    const result = await decodeTranscriptStream(
      Readable.from([...encoded].map((byte) => Uint8Array.of(byte))),
      '/chat.jsonl',
      0,
      decode,
      false
    )

    expect(result.messages[0]?.blocks).toEqual([{ type: 'text', text: line }])
    expect(result.consumedBytes).toBe(encoded.byteLength)
  })

  it('drops an oversized record without retaining it or losing the next line', async () => {
    const oversized = 'x'.repeat(MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES + 1)
    const valid = '{"valid":true}'
    const result = await decodeTranscriptStream(
      Readable.from([oversized, `\n${valid}\n`]),
      '/chat.jsonl',
      0,
      decode,
      true
    )

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.blocks).toEqual([{ type: 'text', text: valid }])
    expect(result.messages[0]?.id).toBe(
      transcriptFallbackId('/chat.jsonl', Buffer.byteLength(`${oversized}\n`, 'utf8'))
    )
    expect(result.consumedBytes).toBe(Buffer.byteLength(`${oversized}\n${valid}\n`, 'utf8'))
  })

  it('consumes an oversized trailing record when trailing lines are included', async () => {
    const oversized = 'x'.repeat(MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES + 1)
    const result = await decodeTranscriptStream(
      Readable.from([oversized]),
      '/chat.jsonl',
      0,
      decode,
      true
    )

    expect(result.messages).toEqual([])
    expect(result.consumedBytes).toBe(Buffer.byteLength(oversized, 'utf8'))
  })
})
