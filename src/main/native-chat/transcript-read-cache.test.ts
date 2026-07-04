import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TranscriptReader from './transcript-reader'

// Spy on the underlying reader so we can assert cache hits issue zero reads.
const readSpy = vi.hoisted(() => vi.fn())
vi.mock('./transcript-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof TranscriptReader>()
  return {
    ...actual,
    readNativeChatTranscript: (...args: Parameters<typeof actual.readNativeChatTranscript>) => {
      readSpy(...args)
      return actual.readNativeChatTranscript(...args)
    }
  }
})

import {
  clearNativeChatTranscriptCache,
  readNativeChatTranscriptCached
} from './transcript-read-cache'

let tempRoots: string[] = []

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

async function seedSession(sessionId: string, turns: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-cache-'))
  tempRoots.push(root)
  const projectDir = join(root, '.claude', 'projects', '-repo')
  await mkdir(projectDir, { recursive: true })
  const records = Array.from({ length: turns }, (_unused, n) => ({
    type: 'user',
    uuid: `u-${n}`,
    timestamp: `2026-06-01T10:00:0${n}.000Z`,
    message: { role: 'user', content: `m${n}` }
  }))
  const filePath = join(projectDir, `${sessionId}.jsonl`)
  await writeFile(filePath, jsonLines(records))
  process.env.HOME = root
  return filePath
}

beforeEach(() => {
  clearNativeChatTranscriptCache()
  readSpy.mockClear()
})

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('readNativeChatTranscriptCached', () => {
  it('returns the same cached object on an mtime hit without re-reading', async () => {
    await seedSession('sess-hit', 3)
    const first = await readNativeChatTranscriptCached('claude', 'sess-hit')
    const second = await readNativeChatTranscriptCached('claude', 'sess-hit')
    expect(readSpy).toHaveBeenCalledTimes(1)
    // Same reference: the second call served the cached parse.
    expect(second).toBe(first)
  })

  it('re-reads when the file mtime changes', async () => {
    const filePath = await seedSession('sess-mtime', 2)
    await readNativeChatTranscriptCached('claude', 'sess-mtime')
    expect(readSpy).toHaveBeenCalledTimes(1)
    // Bump mtime into the future to invalidate without changing content shape.
    const future = new Date(Date.now() + 5_000)
    await utimes(filePath, future, future)
    await readNativeChatTranscriptCached('claude', 'sess-mtime')
    expect(readSpy).toHaveBeenCalledTimes(2)
  })

  it('clear() empties the cache so the next read re-reads', async () => {
    await seedSession('sess-clear', 1)
    await readNativeChatTranscriptCached('claude', 'sess-clear')
    clearNativeChatTranscriptCache()
    await readNativeChatTranscriptCached('claude', 'sess-clear')
    expect(readSpy).toHaveBeenCalledTimes(2)
  })

  it('returns an error result for an unknown session without throwing', async () => {
    await seedSession('present', 1)
    const result = await readNativeChatTranscriptCached('claude', 'absent')
    expect('error' in result && result.error).toBeTruthy()
  })
})
