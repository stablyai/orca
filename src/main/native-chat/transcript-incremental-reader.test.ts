import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  APPEND_BATCH_RETAINED_BYTE_LIMIT,
  createIncrementalTranscriptState,
  readIncrementalTranscriptMessages
} from './transcript-incremental-reader'
import {
  estimateTranscriptMessageRetainedBytes,
  MAX_NATIVE_CHAT_TRANSCRIPT_MESSAGES
} from './transcript-message-retention'
import { transcriptFallbackId } from './transcript-fallback-id'
import { MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES } from './transcript-tail-reader'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('readIncrementalTranscriptMessages', () => {
  it('keeps the newest shared-retention window for an initial snapshot without batching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-transcript-incremental-'))
    tempRoots.push(root)
    const filePath = join(root, 'transcript.jsonl')
    const extraMessages = 5
    await writeFile(
      filePath,
      Array.from(
        { length: MAX_NATIVE_CHAT_TRANSCRIPT_MESSAGES + extraMessages },
        (_unused, index) => `row-${index}\n`
      ).join('')
    )
    const state = createIncrementalTranscriptState()

    const messages = await readIncrementalTranscriptMessages(
      filePath,
      state,
      (line): NativeChatMessage => ({
        id: line,
        role: 'user',
        blocks: [{ type: 'text', text: line }],
        timestamp: null,
        source: 'transcript'
      })
    )

    expect(messages).toHaveLength(MAX_NATIVE_CHAT_TRANSCRIPT_MESSAGES)
    expect(messages[0]?.id).toBe(`row-${extraMessages}`)
    expect(messages.at(-1)?.id).toBe(
      `row-${MAX_NATIVE_CHAT_TRANSCRIPT_MESSAGES + extraMessages - 1}`
    )
  })

  it('flushes append batches by retained bytes before the message-count limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-transcript-incremental-batch-bytes-'))
    tempRoots.push(root)
    const filePath = join(root, 'transcript.jsonl')
    const payload = 'x'.repeat(1024 * 1024)
    const lines = Array.from({ length: 5 }, (_unused, index) => `row-${index}:${payload}`)
    await writeFile(filePath, `${lines.join('\n')}\n`)
    const state = createIncrementalTranscriptState()
    const batches: NativeChatMessage[][] = []
    const decode = (line: string): NativeChatMessage => ({
      id: line.slice(0, line.indexOf(':')),
      role: 'user',
      blocks: [{ type: 'text', text: line }],
      timestamp: null,
      source: 'transcript'
    })

    const remaining = await readIncrementalTranscriptMessages(filePath, state, decode, (messages) =>
      batches.push(messages)
    )
    const delivered = [...batches.flat(), ...remaining]

    expect(batches.map((batch) => batch.length)).toEqual([3])
    expect(delivered.map((message) => message.id)).toEqual(
      Array.from({ length: 5 }, (_unused, index) => `row-${index}`)
    )
    for (const batch of [...batches, remaining]) {
      const retainedBytes = batch.reduce(
        (total, message) =>
          total +
          estimateTranscriptMessageRetainedBytes(
            lines.find((line) => line.startsWith(`${message.id}:`))!.length
          ),
        0
      )
      expect(retainedBytes).toBeLessThanOrEqual(APPEND_BATCH_RETAINED_BYTE_LIMIT)
    }
  })

  it('pauses an aggregate drain at a record boundary and resumes without gaps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-transcript-incremental-drain-budget-'))
    tempRoots.push(root)
    const filePath = join(root, 'transcript.jsonl')
    await writeFile(filePath, 'row-0\nrow-1\nrow-2\nrow-3\nrow-4\n')
    const state = createIncrementalTranscriptState()
    const decode = (line: string): NativeChatMessage => ({
      id: line,
      role: 'user',
      blocks: [{ type: 'text', text: line }],
      timestamp: null,
      source: 'transcript'
    })
    const drain = (): Promise<NativeChatMessage[]> =>
      readIncrementalTranscriptMessages(filePath, state, decode, () => {}, undefined, undefined, {
        maxDrainRetainedBytes: 600
      })

    const first = await drain()
    const firstOffset = state.offset
    const second = await drain()
    const third = await drain()

    expect(first.map((message) => message.id)).toEqual(['row-0', 'row-1'])
    expect(second.map((message) => message.id)).toEqual(['row-2', 'row-3'])
    expect(third.map((message) => message.id)).toEqual(['row-4'])
    expect(firstOffset).toBeGreaterThan(0)
    expect(state.pendingRecord.byteLength).toBe(0)
  })

  it('advances one bounded record when the drain budget is smaller than that record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-transcript-incremental-small-budget-'))
    tempRoots.push(root)
    const filePath = join(root, 'transcript.jsonl')
    await writeFile(filePath, 'row-0\nrow-1\n')
    const state = createIncrementalTranscriptState()
    const decode = (line: string): NativeChatMessage => ({
      id: line,
      role: 'user',
      blocks: [{ type: 'text', text: line }],
      timestamp: null,
      source: 'transcript'
    })
    const drain = (): Promise<NativeChatMessage[]> =>
      readIncrementalTranscriptMessages(filePath, state, decode, () => {}, undefined, undefined, {
        maxDrainRetainedBytes: 1
      })

    const first = await drain()
    const firstOffset = state.offset
    const second = await drain()
    const secondOffset = state.offset
    const exhausted = await drain()

    expect(first.map((message) => message.id)).toEqual(['row-0'])
    expect(second.map((message) => message.id)).toEqual(['row-1'])
    expect(exhausted).toEqual([])
    expect(firstOffset).toBeGreaterThan(0)
    expect(secondOffset).toBeGreaterThan(firstOffset)
  })

  it('keeps the exact fallback offset after discarding an oversized record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-transcript-incremental-oversized-'))
    tempRoots.push(root)
    const filePath = join(root, 'transcript.jsonl')
    const oversized = Buffer.alloc(MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES + 1, 0x78)
    const valid = Buffer.from('valid\n')
    await writeFile(filePath, Buffer.concat([oversized, Buffer.from('\n'), valid]))
    const state = createIncrementalTranscriptState()

    const messages = await readIncrementalTranscriptMessages(
      filePath,
      state,
      (line, fallbackId): NativeChatMessage => ({
        id: fallbackId,
        role: 'user',
        blocks: [{ type: 'text', text: line }],
        timestamp: null,
        source: 'transcript'
      })
    )

    expect(messages.map((message) => message.id)).toEqual([
      transcriptFallbackId(filePath, oversized.byteLength + 1)
    ])
    expect(state.offset).toBe(oversized.byteLength + 1 + valid.byteLength)
    expect(state.pendingRecord.byteLength).toBe(0)
  })
})
