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
})
