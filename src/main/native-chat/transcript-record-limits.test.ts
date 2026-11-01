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

    const tail = await readNativeChatTranscriptTailFile(path, 10, decode)
    const state = createIncrementalTranscriptState()
    const incremental = await readIncrementalTranscriptMessages(path, state, decode)

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
})
