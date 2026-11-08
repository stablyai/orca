import { appendFile, mkdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './session-parse-cache-persistence'
import { createSessionParseStats, parseAgentSessionFileCached } from './session-scanner-parse-cache'
import {
  peekSessionParseCacheEntry,
  resetSessionParseCacheForTests
} from './session-parse-cache-store'
import { parseClaudeSessionFile } from '../scanners/claude/session-scanner-primary-parsers'
import type { FileWithMtime, SessionFileCandidate } from '../session-scanner-types'

const APP_VERSION = '1.2.3-test'
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

// Intermediate artifacts stay inside the repository under a gitignored directory.
const TEST_ROOT = join(import.meta.dirname, '.tmp', 'checkpoint-restart')

let tempRoots: string[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
})

afterEach(async () => {
  resetSessionParseCachePersistenceForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeTestDir(): Promise<string> {
  const root = join(TEST_ROOT, randomUUID())
  await mkdir(root, { recursive: true })
  tempRoots.push(root)
  return root
}

async function claudeCandidate(path: string): Promise<SessionFileCandidate> {
  const fileStat = await stat(path)
  const file: FileWithMtime = {
    path,
    mtimeMs: fileStat.mtimeMs,
    modifiedAt: fileStat.mtime.toISOString(),
    sizeBytes: fileStat.size
  }
  return { agent: 'claude', file, codexHome: null }
}

function userRecord(index: number, text: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId: SESSION_ID,
    timestamp: new Date(1740000000000 + index * 60_000).toISOString(),
    cwd: '/repo/app',
    gitBranch: 'main',
    message: { role: 'user', content: text }
  })
}

function assistantRecord(index: number, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: SESSION_ID,
    timestamp: new Date(1740000000000 + index * 60_000).toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-fable-5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 100, output_tokens: 40 }
    }
  })
}

function customTitleRecord(title: string): string {
  return JSON.stringify({ type: 'custom-title', sessionId: SESSION_ID, customTitle: title })
}

function aiTitleRecord(title: string): string {
  return JSON.stringify({ type: 'ai-title', sessionId: SESSION_ID, aiTitle: title })
}

async function scan(path: string) {
  const stats = createSessionParseStats()
  const session = await parseAgentSessionFileCached(
    await claudeCandidate(path),
    process.platform,
    stats
  )
  return { stats, session }
}

function simulateRestart(cacheFile: string): void {
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
}

function setStoredCheckpoint(cacheFile: string, path: string, checkpoint: unknown): void {
  const db = new SyncDatabase(join(dirname(cacheFile), 'session-parse-cache.sqlite'))
  try {
    db.prepare('UPDATE rows SET checkpoint = ? WHERE path = ?').run(
      checkpoint === null ? null : JSON.stringify(checkpoint),
      path
    )
  } finally {
    db.close()
  }
}

describe('claude parse checkpoints across restarts', () => {
  it('resumes a grown transcript from the persisted checkpoint and matches a full parse', async () => {
    const root = await makeTestDir()
    const cacheFile = join(root, 'vault-state', 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(
      transcript,
      `${userRecord(0, 'first question')}\n${assistantRecord(1, 'answer')}\n`
    )
    const first = await scan(transcript)
    expect(first.stats.fullParses).toBe(1)
    await flushSessionParseCachePersist()

    simulateRestart(cacheFile)
    const appended = `${userRecord(2, 'follow-up question')}\n${assistantRecord(3, 'second answer')}\n`
    await appendFile(transcript, appended)
    const grown = await scan(transcript)
    // The resume read covers the new records plus boundary probing, not the whole file.
    expect(grown.stats.incremental).toBe(1)
    expect(grown.stats.fullParses).toBe(0)
    expect(grown.stats.bytesRead).toBeGreaterThan(0)
    expect(grown.stats.bytesRead).toBeLessThan((await claudeCandidate(transcript)).file.sizeBytes!)

    const whole = await parseClaudeSessionFile((await claudeCandidate(transcript)).file)
    expect(grown.session).toEqual(whole)
  })

  it('advances the checkpoint across consecutive restarts', async () => {
    const root = await makeTestDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(
      transcript,
      `${userRecord(0, 'first question')}\n${assistantRecord(1, 'answer')}\n`
    )
    await scan(transcript)
    await flushSessionParseCachePersist()

    for (const [round, index] of [
      [1, 2],
      [2, 4]
    ] as const) {
      simulateRestart(cacheFile)
      await appendFile(
        transcript,
        `${userRecord(index, `round ${round}`)}\n${assistantRecord(index + 1, `reply ${round}`)}\n`
      )
      const resumed = await scan(transcript)
      expect(resumed.stats.incremental).toBe(1)
      expect(resumed.stats.fullParses).toBe(0)
      await flushSessionParseCachePersist()
    }

    simulateRestart(cacheFile)
    const final = await scan(transcript)
    expect(final.stats.reused).toBe(1)
    const whole = await parseClaudeSessionFile((await claudeCandidate(transcript)).file)
    expect(final.session).toEqual(whole)
  })

  it('reuses the cached session and keeps the checkpoint when the file is unchanged after a restart', async () => {
    const root = await makeTestDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(
      transcript,
      `${userRecord(0, 'first question')}\n${assistantRecord(1, 'answer')}\n`
    )
    const candidate = await claudeCandidate(transcript)
    await scan(transcript)
    await flushSessionParseCachePersist()

    simulateRestart(cacheFile)
    const reused = await scan(transcript)
    expect(reused.stats.reused).toBe(1)
    const stored = peekSessionParseCacheEntry(transcript)
    expect(stored?.checkpoint?.byteOffset).toBe(candidate.file.sizeBytes)
    expect(stored?.checkpoint?.parserKind).toBe('claude')

    // The retained checkpoint still resumes once the file grows again.
    await appendFile(transcript, `${userRecord(2, 'after reuse')}\n`)
    const grown = await scan(transcript)
    expect(grown.stats.incremental).toBe(1)
    expect(grown.stats.fullParses).toBe(0)
  })

  it('fully reparses a truncated transcript instead of resuming', async () => {
    const root = await makeTestDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(
      transcript,
      `${userRecord(0, 'first question')}\n${assistantRecord(1, 'answer')}\n${userRecord(2, 'more')}\n`
    )
    await scan(transcript)
    await flushSessionParseCachePersist()

    simulateRestart(cacheFile)
    await truncate(transcript, 0)
    await writeFile(transcript, `${userRecord(0, 'rewritten')}\n`)
    const truncated = await scan(transcript)
    expect(truncated.stats.incremental).toBe(0)
    expect(truncated.stats.fullParses).toBe(1)

    const whole = await parseClaudeSessionFile((await claudeCandidate(transcript)).file)
    expect(truncated.session).toEqual(whole)
  })

  it('keeps custom titles over later generated ones and updates generated titles after a restart', async () => {
    const root = await makeTestDir()

    // A custom title survives a later ai-title appended after a restart.
    const customPath = join(root, `custom-${SESSION_ID}.jsonl`)
    const customCache = join(root, 'custom', 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: customCache, appVersion: APP_VERSION })
    await writeFile(
      customPath,
      `${userRecord(0, 'first question')}\n${assistantRecord(1, 'answer')}\n${customTitleRecord('Custom X')}\n`
    )
    const customFirst = await scan(customPath)
    expect(customFirst.session?.title).toBe('Custom X')
    await flushSessionParseCachePersist()
    simulateRestart(customCache)
    await appendFile(customPath, `${aiTitleRecord('Generated Y')}\n`)
    const customGrown = await scan(customPath)
    expect(customGrown.session?.title).toBe('Custom X')

    // Without a custom title, a later generated title replaces the earlier generated one.
    const generatedPath = join(root, `generated-${SESSION_ID}.jsonl`)
    const generatedCache = join(root, 'generated', 'session-parse-cache.json')
    resetSessionParseCacheForTests()
    resetSessionParseCachePersistenceForTests()
    initSessionParseCachePersistence({ filePath: generatedCache, appVersion: APP_VERSION })
    await writeFile(
      generatedPath,
      `${userRecord(0, 'first question')}\n${assistantRecord(1, 'answer')}\n${aiTitleRecord('Generated Y')}\n`
    )
    const generatedFirst = await scan(generatedPath)
    expect(generatedFirst.session?.title).toBe('Generated Y')
    await flushSessionParseCachePersist()
    simulateRestart(generatedCache)
    await appendFile(generatedPath, `${aiTitleRecord('Generated Z')}\n`)
    const generatedGrown = await scan(generatedPath)
    expect(generatedGrown.stats.incremental).toBe(1)
    expect(generatedGrown.session?.title).toBe('Generated Z')
  })

  it('counts a completed trailing record exactly once across a restart', async () => {
    const root = await makeTestDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = join(root, `${SESSION_ID}.jsonl`)
    // The assistant record stays unterminated: display includes it, the checkpoint must not.
    await writeFile(
      transcript,
      `${userRecord(0, 'first question')}\n${assistantRecord(1, 'answer')}`
    )
    const first = await scan(transcript)
    expect(first.session?.messageCount).toBe(2)
    await flushSessionParseCachePersist()

    simulateRestart(cacheFile)
    await appendFile(transcript, '\n')
    const completed = await scan(transcript)
    expect(completed.stats.incremental).toBe(1)

    const whole = await parseClaudeSessionFile((await claudeCandidate(transcript)).file)
    expect(completed.session).toEqual(whole)
    expect(completed.session?.messageCount).toBe(2)
  })

  it('fully reparses when the persisted checkpoint version or payload does not match', async () => {
    const root = await makeTestDir()

    const stalePath = join(root, `stale-${SESSION_ID}.jsonl`)
    const staleCache = join(root, 'stale', 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: staleCache, appVersion: APP_VERSION })
    await writeFile(
      stalePath,
      `${userRecord(0, 'first question')}\n${assistantRecord(1, 'answer')}\n`
    )
    await scan(stalePath)
    await flushSessionParseCachePersist()
    const staleCheckpoint = peekSessionParseCacheEntry(stalePath)?.checkpoint
    expect(staleCheckpoint).toBeDefined()
    const staleVersion = staleCheckpoint?.snapshotVersion ?? 0
    simulateRestart(staleCache)
    setStoredCheckpoint(staleCache, stalePath, {
      ...staleCheckpoint,
      snapshotVersion: staleVersion + 1
    })
    await appendFile(stalePath, `${userRecord(2, 'after version bump')}\n`)
    const stale = await scan(stalePath)
    expect(stale.stats.incremental).toBe(0)
    expect(stale.stats.fullParses).toBe(1)

    const corruptPath = join(root, `corrupt-${SESSION_ID}.jsonl`)
    const corruptCache = join(root, 'corrupt', 'session-parse-cache.json')
    resetSessionParseCacheForTests()
    resetSessionParseCachePersistenceForTests()
    initSessionParseCachePersistence({ filePath: corruptCache, appVersion: APP_VERSION })
    await writeFile(
      corruptPath,
      `${userRecord(0, 'first question')}\n${assistantRecord(1, 'answer')}\n`
    )
    await scan(corruptPath)
    await flushSessionParseCachePersist()
    simulateRestart(corruptCache)
    setStoredCheckpoint(corruptCache, corruptPath, {
      ...peekSessionParseCacheEntry(corruptPath)?.checkpoint,
      snapshot: { not: 'a claude snapshot' }
    })
    await appendFile(corruptPath, `${userRecord(2, 'after corruption')}\n`)
    const corrupt = await scan(corruptPath)
    expect(corrupt.stats.incremental).toBe(0)
    expect(corrupt.stats.fullParses).toBe(1)
    const whole = await parseClaudeSessionFile((await claudeCandidate(corruptPath)).file)
    expect(corrupt.session).toEqual(whole)
  })

  it('keeps the previous checkpoint when a read is cancelled', async () => {
    const root = await makeTestDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(
      transcript,
      `${userRecord(0, 'first question')}\n${assistantRecord(1, 'answer')}\n`
    )
    const candidate = await claudeCandidate(transcript)
    await scan(transcript)
    await flushSessionParseCachePersist()
    const committed = peekSessionParseCacheEntry(transcript)?.checkpoint?.byteOffset
    expect(committed).toBe(candidate.file.sizeBytes)

    simulateRestart(cacheFile)
    await appendFile(transcript, `${userRecord(2, 'cancelled turn')}\n`)
    const cancelledStats = createSessionParseStats()
    await expect(
      parseAgentSessionFileCached(
        await claudeCandidate(transcript),
        process.platform,
        cancelledStats,
        undefined,
        AbortSignal.abort('cancelled-by-test')
      )
    ).rejects.toThrow()
    // The failed read must not advance the persisted checkpoint.
    expect(peekSessionParseCacheEntry(transcript)?.checkpoint?.byteOffset).toBe(committed)
  })
})
