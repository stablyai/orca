import { appendFile, mkdtemp, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import { getSessionParseCacheEntry } from './session-parse-cache-store'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from './session-transcript-record-budget'
import type { SessionFileCandidate } from './session-scanner-types'

async function candidate(path: string): Promise<SessionFileCandidate> {
  const info = await stat(path)
  return {
    agent: 'claude',
    codexHome: null,
    file: {
      path,
      mtimeMs: info.mtimeMs,
      modifiedAt: info.mtime.toISOString(),
      sizeBytes: info.size
    }
  }
}

it('preserves the resume point after rejection and reads repaired appends once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-record-budget-'))
  const path = join(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
  const first = `${JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: 'first' } })}\n`
  const second = `${JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: 'second' } })}\n`
  resetSessionParseCacheForTests()
  try {
    await writeFile(path, first)
    await parseAgentSessionFileCached(await candidate(path), process.platform)
    const cached = getSessionParseCacheEntry(path)
    expect(cached?.resume?.byteOffset).toBe(Buffer.byteLength(first))

    await appendFile(path, second)
    await appendFile(path, Buffer.alloc(MAX_SESSION_TRANSCRIPT_RECORD_BYTES + 1, 'x'))
    await expect(
      parseAgentSessionFileCached(await candidate(path), process.platform)
    ).rejects.toThrow('byte limit')
    expect(getSessionParseCacheEntry(path)).toBe(cached)
    expect(cached?.resume?.byteOffset).toBe(Buffer.byteLength(first))

    await truncate(path, Buffer.byteLength(first + second))
    const repaired = await parseAgentSessionFileCached(await candidate(path), process.platform)
    expect(repaired?.previewMessages.map((message) => message.text)).toEqual(['first', 'second'])
    expect(getSessionParseCacheEntry(path)?.resume?.byteOffset).toBe(
      Buffer.byteLength(first + second)
    )
  } finally {
    resetSessionParseCacheForTests()
    await rm(root, { recursive: true, force: true })
  }
})
