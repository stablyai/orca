import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { transcriptFallbackId } from './transcript-fallback-id'
import {
  createIncrementalTranscriptState,
  readIncrementalTranscriptMessages
} from './transcript-incremental-reader'
import { readNativeChatTranscriptTailFile } from './transcript-tail-reader'

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function transcript(content: string | Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-transcript-copy-counts-'))
  directories.push(directory)
  const path = join(directory, 'session.jsonl')
  await writeFile(path, content)
  return path
}

function decode(line: string, id: string): NativeChatMessage | null {
  try {
    JSON.parse(line)
  } catch {
    return null
  }
  return {
    id,
    role: 'user',
    timestamp: null,
    source: 'transcript',
    blocks: [{ type: 'text', text: line }]
  }
}

function observeBufferCopies() {
  const concat = Buffer.concat
  const copiedBytes: number[] = []
  const copiedParts: number[] = []
  vi.spyOn(Buffer, 'concat').mockImplementation((parts, length) => {
    // Record before the reader clears its reused parts array.
    copiedBytes.push(parts.reduce((total, part) => total + part.length, 0))
    copiedParts.push(parts.length)
    return concat(parts, length)
  })
  return { copiedBytes, copiedParts }
}

describe('native transcript record copies', () => {
  it('copies no single-part record buffers and preserves UTF-8, CRLF, malformed rows, and byte ids', async () => {
    const records = Array.from({ length: 300 }, (_unused, index) =>
      JSON.stringify({ text: `é😀 record ${index}` })
    )
    const prefix = '\r\nmalformed\n\n'
    const content = prefix + records.map((record) => `${record}\r\n`).join('')
    const path = await transcript(content)
    let offset = Buffer.byteLength(prefix)
    const expected = records.map((record) => {
      const message = decode(record, transcriptFallbackId(path, offset))
      offset += Buffer.byteLength(record) + 2
      return message
    })
    const { copiedBytes } = observeBufferCopies()
    const incremental = await readIncrementalTranscriptMessages(
      path,
      createIncrementalTranscriptState(),
      decode
    )
    const incrementalCopiedBytes = copiedBytes.reduce((total, bytes) => total + bytes, 0)
    copiedBytes.length = 0
    const tail = await readNativeChatTranscriptTailFile(path, 400, decode)
    const tailCopiedBytes = copiedBytes.reduce((total, bytes) => total + bytes, 0)

    expect(incremental).toEqual(expected)
    expect(tail).toEqual({
      messages: expected,
      consumedTo: Buffer.byteLength(content),
      hasMore: false,
      beforeOffset: Buffer.byteLength(prefix),
      malformedRecordCount: 1
    })
    expect({ incrementalCopiedBytes, tailCopiedBytes }).toEqual({
      incrementalCopiedBytes: 0,
      tailCopiedBytes: 0
    })
  })

  it('still joins multi-part records once and preserves forward and reverse byte order', async () => {
    const large = JSON.stringify({ text: 'é😀'.repeat(20_000) })
    const small = JSON.stringify({ text: 'last' })
    const content = `${large}\r\n${small}\n`
    const path = await transcript(content)
    const expected = [
      decode(large, transcriptFallbackId(path, 0)),
      decode(small, transcriptFallbackId(path, Buffer.byteLength(large) + 2))
    ]
    const { copiedBytes, copiedParts } = observeBufferCopies()
    const incremental = await readIncrementalTranscriptMessages(
      path,
      createIncrementalTranscriptState(),
      decode
    )
    expect(incremental).toEqual(expected)
    expect(copiedBytes).toEqual([Buffer.byteLength(large) + 1])
    expect(copiedParts[0]).toBeGreaterThan(1)
    copiedBytes.length = 0
    copiedParts.length = 0
    const tail = await readNativeChatTranscriptTailFile(path, 10, decode)
    expect(tail.messages).toEqual(expected)
    expect(copiedBytes).toEqual([Buffer.byteLength(large) + 1])
    expect(copiedParts[0]).toBeGreaterThan(1)
  })

  it('retains a UTF-8 codepoint split between appends and emits the original absolute byte id', async () => {
    const complete = `${JSON.stringify({ text: 'first' })}\n`
    const next = Buffer.from(`${JSON.stringify({ text: '😀 next' })}\n`)
    const split = Buffer.byteLength('{"text":"') + 2
    const path = await transcript(Buffer.concat([Buffer.from(complete), next.subarray(0, split)]))
    const state = createIncrementalTranscriptState()
    const first = await readIncrementalTranscriptMessages(path, state, decode)
    expect(first).toEqual([decode(complete.slice(0, -1), transcriptFallbackId(path, 0))])
    expect(state.pendingBytes).toBe(split)
    await appendFile(path, next.subarray(split))
    const appended = await readIncrementalTranscriptMessages(path, state, decode)
    expect(appended).toEqual([
      decode(
        next.toString('utf8').slice(0, -1),
        transcriptFallbackId(path, Buffer.byteLength(complete))
      )
    ])
    expect(state.pendingBytes).toBe(0)
    expect(state.offset).toBe(Buffer.byteLength(complete) + next.length)
  })

  it('keeps only the head of a record too large to read, never a join of all of it', async () => {
    const big = `{"type":"event_msg","payload":{"text":"${'x'.repeat(3 * 1024 * 1024)}"}}`
    const head = big.slice(0, 4096)
    // Several appends, so the record arrives as many parts before it crosses the cap.
    const path = await transcript('')
    for (let at = 0; at < big.length; at += 256 * 1024) {
      await appendFile(path, big.slice(at, at + 256 * 1024))
    }
    await appendFile(path, '\n{"after":true}\n')
    const heads: Buffer[] = []
    const messages = await readIncrementalTranscriptMessages(
      path,
      createIncrementalTranscriptState(),
      decode,
      undefined,
      undefined,
      undefined,
      undefined,
      (observed) => heads.push(observed)
    )
    expect(heads.map((observed) => observed.toString('utf8'))).toEqual([head])
    // The head owns its bytes rather than viewing a multi-megabyte join.
    expect(heads[0]!.buffer.byteLength).toBeLessThanOrEqual(64 * 1024)
    expect(messages.map((message) => message.blocks)).toEqual([
      [{ type: 'text', text: '{"after":true}' }]
    ])
  })
})
