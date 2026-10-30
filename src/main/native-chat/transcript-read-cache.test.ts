import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TranscriptReader from './transcript-reader'

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

import { isTextBlock } from '../../shared/native-chat-types'
import {
  clearNativeChatTranscriptCache,
  readNativeChatTranscriptCached,
  setNativeChatTranscriptCacheMaxBytesForTests
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

/** Seed explicit-path transcripts to keep resolution independent of the real user home. */
async function seedBigFile(name: string, bytes: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-cache-bytes-'))
  tempRoots.push(root)
  const filePath = join(root, `${name}.jsonl`)
  const record = {
    type: 'user',
    uuid: `u-${name}`,
    timestamp: '2026-06-01T10:00:00.000Z',
    message: { role: 'user', content: 'x'.repeat(Math.max(1, bytes)) }
  }
  await writeFile(filePath, jsonLines([record]))
  return filePath
}

beforeEach(() => {
  clearNativeChatTranscriptCache()
  setNativeChatTranscriptCacheMaxBytesForTests()
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
    expect(second).toBe(first)
  })

  it('re-reads when the file mtime changes', async () => {
    const filePath = await seedSession('sess-mtime', 2)
    await readNativeChatTranscriptCached('claude', 'sess-mtime')
    expect(readSpy).toHaveBeenCalledTimes(1)
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

  it('marks a resolve miss as notFound and does not cache it', async () => {
    await seedSession('present-2', 1)
    const first = await readNativeChatTranscriptCached('claude', 'absent-2')
    expect('error' in first && first.notFound).toBe(true)
    expect(readSpy).not.toHaveBeenCalled()
    const second = await readNativeChatTranscriptCached('claude', 'absent-2')
    expect(second).not.toBe(first)
  })

  it('never serves one file’s parse for a different file that shares a sessionId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-cache-xwt-'))
    tempRoots.push(root)
    const fileA = join(root, 'worktree-a.jsonl')
    const fileC = join(root, 'worktree-c.jsonl')
    await writeFile(
      fileA,
      jsonLines([
        {
          type: 'user',
          uuid: 'a0',
          timestamp: '2026-06-01T10:00:00.000Z',
          message: { role: 'user', content: 'from-worktree-A' }
        }
      ])
    )
    await writeFile(
      fileC,
      jsonLines([
        {
          type: 'user',
          uuid: 'c0',
          timestamp: '2026-06-01T10:00:00.000Z',
          message: { role: 'user', content: 'from-worktree-C' }
        }
      ])
    )
    // Equal mtimes expose session-ID collisions that timestamp invalidation would otherwise hide.
    const when = new Date('2026-06-01T10:00:00.000Z')
    await utimes(fileA, when, when)
    await utimes(fileC, when, when)

    const readText = (
      result: Awaited<ReturnType<typeof readNativeChatTranscriptCached>>
    ): string =>
      'messages' in result
        ? result.messages
            .flatMap((message) => message.blocks)
            .filter(isTextBlock)
            .map((block) => block.text)
            .join(' ')
        : ''

    const a = await readNativeChatTranscriptCached('claude', 'shared-session', fileA)
    const c = await readNativeChatTranscriptCached('claude', 'shared-session', fileC)

    expect(readText(a)).toContain('from-worktree-A')
    expect(readText(c)).toContain('from-worktree-C')
    expect(readText(c)).not.toContain('from-worktree-A')
    expect(c).not.toBe(a)
  })

  it('evicts the oldest entry once total cached bytes exceed the budget', async () => {
    // Three 4-KB files exceed 9 KB, evicting the oldest.
    setNativeChatTranscriptCacheMaxBytesForTests(9 * 1024)
    const fileA = await seedBigFile('big-a', 4 * 1024)
    const fileB = await seedBigFile('big-b', 4 * 1024)
    const fileC = await seedBigFile('big-c', 4 * 1024)

    await readNativeChatTranscriptCached('claude', 'sa', fileA)
    await readNativeChatTranscriptCached('claude', 'sb', fileB)
    await readNativeChatTranscriptCached('claude', 'sc', fileC)
    expect(readSpy).toHaveBeenCalledTimes(3)

    await readNativeChatTranscriptCached('claude', 'sc', fileC)
    expect(readSpy).toHaveBeenCalledTimes(3)

    await readNativeChatTranscriptCached('claude', 'sa', fileA)
    expect(readSpy).toHaveBeenCalledTimes(4)

    await readNativeChatTranscriptCached('claude', 'sb', fileB)
    expect(readSpy).toHaveBeenCalledTimes(5)
  })

  it('keeps a single active transcript larger than the whole budget cached', async () => {
    setNativeChatTranscriptCacheMaxBytesForTests(1024)
    const big = await seedBigFile('huge', 8 * 1024)
    await readNativeChatTranscriptCached('claude', 'huge', big)
    await readNativeChatTranscriptCached('claude', 'huge', big)
    expect(readSpy).toHaveBeenCalledTimes(1)
  })

  it('does not evict small entries under the default budget (no regression for typical use)', async () => {
    const files = await Promise.all([
      seedBigFile('s1', 512),
      seedBigFile('s2', 512),
      seedBigFile('s3', 512)
    ])
    for (const [i, file] of files.entries()) {
      await readNativeChatTranscriptCached('claude', `sess-${i}`, file)
    }
    expect(readSpy).toHaveBeenCalledTimes(3)
    for (const [i, file] of files.entries()) {
      await readNativeChatTranscriptCached('claude', `sess-${i}`, file)
    }
    expect(readSpy).toHaveBeenCalledTimes(3)
  })
})
