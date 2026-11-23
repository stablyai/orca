import { appendFile, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mergeTranscriptRanges,
  type TranscriptByteRange
} from '../../../shared/native-chat/transcript/transcript-byte-range'
import {
  readNativeChatTranscriptTailFile,
  type NativeChatLineDecoder
} from '../transcript-tail-reader'
import { readAndEmitTranscriptAppends } from './transcript-append-emitter'
import { createIncrementalTranscriptState } from './transcript-incremental-reader'
import { verifyTranscriptRanges } from './transcript-range-verifier'

// PR #45168: non-message append lines must not fragment held-history verification into repeated reads.
describe.each([10_000, 100_000])('transcript range continuity at %i messages', (count) => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
  afterEach(() => vi.useRealTimers())

  it('keeps mixed append bursts in one verifiable range and sends no frame for non-message drains', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-chat-continuity-'))
    const file = join(directory, 'session.jsonl')
    const decode: NativeChatLineDecoder = (line, id) =>
      line === '{"message":true}'
        ? {
            id,
            role: 'user',
            blocks: [{ type: 'text', text: 'held message' }],
            timestamp: 1,
            source: 'transcript'
          }
        : null
    try {
      await writeFile(file, '{"message":true}\n{}\n{}\n{}\n'.repeat(count))
      const snapshot = await readNativeChatTranscriptTailFile(file, count, decode)
      const state = createIncrementalTranscriptState()
      state.offset = snapshot.consumedTo
      state.pendingStart = snapshot.consumedTo
      const ranges: TranscriptByteRange[] = [...(snapshot.ranges ?? [])]
      let frames = 0
      const drain = async (lines: string[]): Promise<number> => {
        const before = frames
        await appendFile(file, lines.join(''))
        await readAndEmitTranscriptAppends(
          file,
          state,
          decode,
          {
            agent: 'claude',
            sessionId: 'session',
            sourceOrder: true,
            onAppend: (_messages, _lifecycle, frameRanges) => {
              frames++
              ranges.push(...(frameRanges ?? []))
            }
          },
          () => true,
          new AbortController().signal
        )
        return frames - before
      }
      for (let burst = 0; burst < 20; burst++) {
        // Bursts start with non-message lines, so a range that begins at the first message leaves a gap.
        const lines = Array.from({ length: 5 + (burst % 8) * 5 }, (_, index) =>
          index % 4 === 3 ? '{"message":true}\n' : '{}\n'
        )
        await drain(lines)
        expect(await drain(['{}\n'])).toBe(0)
      }
      expect(await drain(['{"message":true}\n'])).toBe(1)
      const merged = mergeTranscriptRanges(ranges)
      expect(merged).toHaveLength(1)
      expect(merged[0]?.start).toBe(0)
      expect(merged[0]?.end).toBe((await stat(file)).size)
      expect(await verifyTranscriptRanges(file, merged)).toEqual([true])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('stays unsettled on appends and touches during a verify and matches once the file is quiet', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-chat-continuity-'))
    const file = join(directory, 'session.jsonl')
    const decode: NativeChatLineDecoder = (line, id) =>
      line === '{"message":true}'
        ? {
            id,
            role: 'user',
            blocks: [{ type: 'text', text: 'held message' }],
            timestamp: 1,
            source: 'transcript'
          }
        : null
    try {
      await writeFile(file, '{"message":true}\n{}\n{}\n{}\n'.repeat(count))
      const snapshot = await readNativeChatTranscriptTailFile(file, count, decode)
      const verifying = verifyTranscriptRanges(file, snapshot.ranges ?? [])
      await appendFile(file, '{"message":true}\n')
      expect(await verifying).toBe('unsettled')
      expect(await verifyTranscriptRanges(file, snapshot.ranges ?? [])).toEqual([true])
      const touched = verifyTranscriptRanges(file, snapshot.ranges ?? [])
      await utimes(file, new Date(1_000), new Date(2_000))
      expect(await touched).toBe('unsettled')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
