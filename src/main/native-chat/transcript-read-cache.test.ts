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

// Writes a transcript file at an explicit path whose on-disk size is ~`bytes`
// (padded via one big user message), returning the path. Read it back by passing
// the path as `transcriptPath` so resolution doesn't depend on process.env.HOME.
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

  // Why: a just-created session's transcript can take up to minutes to exist on
  // disk (#8401) — the miss must be marked notFound so watch/renderer callers
  // retry instead of settling into a permanent error, and it must never be
  // cached (a real error already isn't cached; this locks in the same for a miss).
  it('marks a resolve miss as notFound and does not cache it', async () => {
    await seedSession('present-2', 1)
    const first = await readNativeChatTranscriptCached('claude', 'absent-2')
    expect('error' in first && first.notFound).toBe(true)
    expect(readSpy).not.toHaveBeenCalled()
    const second = await readNativeChatTranscriptCached('claude', 'absent-2')
    expect(second).not.toBe(first)
  })

  // Why: two worktrees can present the SAME (agent, sessionId) via different
  // transcript files — e.g. the same session resumed into a second worktree,
  // which writes a new transcript file. Keying the cache by sessionId let one
  // worktree's cached parse be served to the other whenever their file mtimes
  // coincided, leaking A's chat transcript into C's panel (#7326).
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
    // Force IDENTICAL mtimes so a sessionId-only key's mtime guard cannot rescue
    // the collision — this is the intermittent, activity-driven case.
    const when = new Date('2026-06-01T10:00:00.000Z')
    await utimes(fileA, when, when)
    await utimes(fileC, when, when)

    const readText = (result: Awaited<ReturnType<typeof readNativeChatTranscriptCached>>): string =>
      'messages' in result
        ? result.messages
            .flatMap((message) => message.blocks)
            .filter(isTextBlock)
            .map((block) => block.text)
            .join(' ')
        : ''

    // Same sessionId, different transcript files (worktree A resumed into C).
    const a = await readNativeChatTranscriptCached('claude', 'shared-session', fileA)
    const c = await readNativeChatTranscriptCached('claude', 'shared-session', fileC)

    expect(readText(a)).toContain('from-worktree-A')
    expect(readText(c)).toContain('from-worktree-C')
    expect(readText(c)).not.toContain('from-worktree-A')
    // Distinct files must not share a cached parse object.
    expect(c).not.toBe(a)
  })

  // Why: each cached entry is a FULL unwindowed transcript parse; heavy agent
  // sessions are tens of MB, so the count-only cap let 50 entries retain multiple
  // GB in the one process serving desktop + every paired client. The byte budget
  // evicts the oldest large entries while always keeping the most-recent.
  it('evicts the oldest entry once total cached bytes exceed the budget', async () => {
    // ~4 KB per file, budget 9 KB → holds 2, a third read evicts the oldest.
    setNativeChatTranscriptCacheMaxBytesForTests(9 * 1024)
    const fileA = await seedBigFile('big-a', 4 * 1024)
    const fileB = await seedBigFile('big-b', 4 * 1024)
    const fileC = await seedBigFile('big-c', 4 * 1024)

    await readNativeChatTranscriptCached('claude', 'sa', fileA) // spy 1
    await readNativeChatTranscriptCached('claude', 'sb', fileB) // spy 2
    await readNativeChatTranscriptCached('claude', 'sc', fileC) // spy 3, evicts A
    expect(readSpy).toHaveBeenCalledTimes(3)

    // C is the most-recent → still cached (no re-read).
    await readNativeChatTranscriptCached('claude', 'sc', fileC)
    expect(readSpy).toHaveBeenCalledTimes(3)

    // A was evicted by the byte cap → this re-reads (and evicts B in turn).
    await readNativeChatTranscriptCached('claude', 'sa', fileA)
    expect(readSpy).toHaveBeenCalledTimes(4)

    // B is now evicted → also re-reads.
    await readNativeChatTranscriptCached('claude', 'sb', fileB)
    expect(readSpy).toHaveBeenCalledTimes(5)
  })

  it('keeps a single active transcript larger than the whole budget cached', async () => {
    // A lone entry over budget must NOT be dropped, else every read re-parses.
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
    // Re-read all three: every one is still cached (byte budget never triggered).
    for (const [i, file] of files.entries()) {
      await readNativeChatTranscriptCached('claude', `sess-${i}`, file)
    }
    expect(readSpy).toHaveBeenCalledTimes(3)
  })
})
