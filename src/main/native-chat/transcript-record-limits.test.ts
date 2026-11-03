import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import {
  createIncrementalTranscriptState,
  readIncrementalTranscriptMessages
} from './transcript-incremental-reader'
import {
  MAX_NATIVE_CHAT_IMAGE_TRANSCRIPT_RECORD_BYTES,
  MAX_NATIVE_CHAT_INLINE_IMAGE_READ_BYTES,
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES
} from './transcript-record-limits'
import { readNativeChatTranscriptTailFile } from './transcript-tail-reader'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function transcript(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-transcript-limits-'))
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
  return { id, role: 'user', timestamp: null, source: 'transcript', blocks: [] }
}

// Builds one JSONL line of exactly `bytes` bytes (excluding the newline).
function recordOfBytes(bytes: number): string {
  const prefix = '{"p":"'
  const suffix = '"}'
  return prefix + 'A'.repeat(bytes - prefix.length - suffix.length) + suffix
}

function textRecordOfBytes(bytes: number): string {
  return recordOfBytes(bytes)
}

function imageRecordOfBytes(bytes: number): string {
  const prefix = '{"source":{"type":"base64","data":"'
  const suffix = '"}}'
  return prefix + 'A'.repeat(bytes - prefix.length - suffix.length) + suffix
}

// Mimics the real decoder: only records with a valid base64 image source become image-ref blocks.
function imageDecode(line: string, id: string): NativeChatMessage | null {
  let parsed: { source?: { type?: string; data?: string } }
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  const data = parsed.source?.type === 'base64' ? parsed.source.data : undefined
  return {
    id,
    role: 'user',
    timestamp: null,
    source: 'transcript',
    blocks: data ? [{ type: 'image-ref', url: `data:image/png;base64,${data}` }] : []
  }
}

function imageLine(index: number, bytes: number): string {
  return JSON.stringify({ i: index, source: { type: 'base64', data: 'A'.repeat(bytes) } })
}

describe('native chat transcript record limits', () => {
  it('still drops a plain text record above 2 MiB through both readers', async () => {
    const plain = textRecordOfBytes(MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES + 1)
    const path = await transcript(`${plain}\n${recordOfBytes(100)}\n`)

    const tail = await readNativeChatTranscriptTailFile(path, 10, decode)
    const incremental = await readIncrementalTranscriptMessages(
      path,
      createIncrementalTranscriptState(),
      decode
    )

    expect(tail.messages).toHaveLength(1)
    expect(tail.oversizedRecordCount).toBe(1)
    expect(incremental).toHaveLength(1)
  })

  it('accepts a record carrying the largest cacheable screenshot as inline base64', () => {
    const base64Bytes = Math.ceil(NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES / 3) * 4
    expect(MAX_NATIVE_CHAT_IMAGE_TRANSCRIPT_RECORD_BYTES).toBeGreaterThan(base64Bytes)
    expect(MAX_NATIVE_CHAT_IMAGE_TRANSCRIPT_RECORD_BYTES).toBeGreaterThan(
      MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES
    )
  })

  it('reads a record above the old 2 MiB guard through both readers', async () => {
    // 1,678,285 decoded bytes (the PNG from the review repro) is 2,237,716 base64 bytes.
    const path = await transcript(`${imageRecordOfBytes(2_238_001)}\n`)

    const tail = await readNativeChatTranscriptTailFile(path, 10, imageDecode)
    const state = createIncrementalTranscriptState()
    const incremental = await readIncrementalTranscriptMessages(path, state, imageDecode)

    expect(tail.messages).toHaveLength(1)
    expect(tail.oversizedRecordCount).toBeUndefined()
    expect(incremental).toHaveLength(1)
  })

  it('still drops a record above the image-aware limit and keeps later records', async () => {
    const oversized = imageRecordOfBytes(MAX_NATIVE_CHAT_IMAGE_TRANSCRIPT_RECORD_BYTES + 1)
    const path = await transcript(`${oversized}\n${recordOfBytes(100)}\n`)

    const tail = await readNativeChatTranscriptTailFile(path, 10, decode)
    const state = createIncrementalTranscriptState()
    const incremental = await readIncrementalTranscriptMessages(path, state, decode)

    expect(tail.messages).toHaveLength(1)
    expect(tail.oversizedRecordCount).toBe(1)
    expect(incremental).toHaveLength(1)
  })

  it('drops a large plain-text record that only carries a base64 marker', async () => {
    const fake = `{"note":"base64","p":"${'A'.repeat(MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES)}"}`
    const path = await transcript(`${fake}\n${recordOfBytes(100)}\n`)

    const tail = await readNativeChatTranscriptTailFile(path, 10, imageDecode)
    const incremental = await readIncrementalTranscriptMessages(
      path,
      createIncrementalTranscriptState(),
      imageDecode
    )

    expect(tail.messages).toHaveLength(1)
    expect(tail.oversizedRecordCount).toBe(1)
    expect(incremental).toHaveLength(1)
  })

  it('caps inline image bytes per read and flushes append batches by bytes', async () => {
    const imageBytes = 10 * 1024 * 1024
    const count = Math.floor(MAX_NATIVE_CHAT_INLINE_IMAGE_READ_BYTES / imageBytes) + 1
    const path = await transcript(
      Array.from({ length: count }, (_unused, i) => `${imageLine(i, imageBytes)}\n`).join('')
    )

    const tail = await readNativeChatTranscriptTailFile(path, 100, imageDecode)
    expect(tail.messages).toHaveLength(count - 1)
    expect(tail.oversizedRecordCount).toBe(1)

    const batches: number[] = []
    const appended = await readIncrementalTranscriptMessages(
      path,
      createIncrementalTranscriptState(),
      imageDecode,
      (messages) => batches.push(messages.length)
    )
    expect(batches.reduce((a, b) => a + b, 0) + appended.length).toBe(count)
    expect(batches.length).toBeGreaterThan(0)

    const snapshot = await readIncrementalTranscriptMessages(
      path,
      createIncrementalTranscriptState(),
      imageDecode
    )
    expect(snapshot).toHaveLength(count - 1)
  })
})
