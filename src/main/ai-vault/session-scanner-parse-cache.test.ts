import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isAiVaultScanCancelledError } from '../../shared/ai-vault-types'
import { getSessionParseCacheEntry } from './session-parse-cache-store'
import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests,
  createSessionParseStats
} from './session-scanner-parse-cache'
import { parseClaudeSessionFile } from './session-scanner-primary-parsers'
import type { FileWithMtime, SessionFileCandidate } from './session-scanner-types'
import {
  registerTranscriptConsumer,
  resetTranscriptConsumersForTests,
  type TranscriptReadOutcome
} from './session-transcript-consumers'

let tempRoots: string[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-parse-cache-'))
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
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    timestamp: new Date(1740000000000 + index * 60_000).toISOString(),
    cwd: '/repo/app',
    gitBranch: 'main',
    message: { role: 'user', content: text }
  })
}

function assistantRecord(index: number, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    timestamp: new Date(1740000000000 + index * 60_000).toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-fable-5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 100, output_tokens: 40 }
    }
  })
}

async function freshParse(path: string) {
  const candidate = await claudeCandidate(path)
  return parseClaudeSessionFile(candidate.file)
}

async function cachedParse(path: string) {
  const candidate = await claudeCandidate(path)
  return parseAgentSessionFileCached(candidate, process.platform)
}

describe('parseAgentSessionFileCached', () => {
  it('returns the identical cached session for an unchanged file', async () => {
    const root = await makeTempDir()
    const path = join(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    await writeFile(path, `${userRecord(0, 'first question')}\n${assistantRecord(1, 'answer')}\n`)

    const stats = createSessionParseStats()
    const candidate = await claudeCandidate(path)
    const first = await parseAgentSessionFileCached(candidate, process.platform, stats)
    const second = await parseAgentSessionFileCached(candidate, process.platform, stats)

    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(stats.fullParses).toBe(1)
    expect(stats.reused).toBe(1)
    expect(stats.incremental).toBe(0)
  })

  it('incrementally parses appended lines and matches a cold parse exactly', async () => {
    const root = await makeTempDir()
    const path = join(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    await writeFile(
      path,
      `${[
        userRecord(0, 'first question'),
        assistantRecord(1, 'first answer'),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Original title' })
      ].join('\n')}\n`
    )
    const stats = createSessionParseStats()
    await parseAgentSessionFileCached(await claudeCandidate(path), process.platform, stats)

    await appendFile(
      path,
      `${[
        userRecord(2, 'second question'),
        assistantRecord(3, 'second answer'),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Revised title' }),
        assistantRecord(4, 'third answer')
      ].join('\n')}\n`
    )

    const incremental = await parseAgentSessionFileCached(
      await claudeCandidate(path),
      process.platform,
      stats
    )
    expect(stats.incremental).toBe(1)
    expect(incremental).toEqual(await freshParse(path))
    expect(incremental?.messageCount).toBe(5)
    expect(incremental?.title).toBe('Revised title')
    expect(incremental?.totalTokens).toBe(420)
  })

  it('parses a multi-chunk record without quadratic carry copying', async () => {
    const root = await makeTempDir()
    const path = join(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    // Span many chunks to expose quadratic copying from repeatedly joining the carried record prefix.
    const recordBytes = 4 * 1024 * 1024
    await writeFile(
      path,
      `${[
        userRecord(0, 'question'),
        assistantRecord(1, 'x'.repeat(recordBytes)),
        assistantRecord(2, 'tail answer')
      ].join('\n')}\n`
    )

    const originalConcat = Buffer.concat
    let concatenatedBytes = 0
    Buffer.concat = ((list: readonly Uint8Array[], totalLength?: number) => {
      const joined = originalConcat(list as Uint8Array[], totalLength)
      concatenatedBytes += joined.length
      return joined
    }) as typeof Buffer.concat
    try {
      const stats = createSessionParseStats()
      const parsed = await parseAgentSessionFileCached(
        await claudeCandidate(path),
        process.platform,
        stats
      )
      expect(parsed?.messageCount).toBe(3)
      expect(parsed?.previewMessages.map((message) => message.text)).toEqual([
        'question',
        expect.stringMatching(/^x+\.\.\.$/),
        'tail answer'
      ])
    } finally {
      Buffer.concat = originalConcat
    }

    expect(concatenatedBytes).toBeLessThan(recordBytes * 4)
  })

  it('shows a trailing unterminated line without double-counting it later', async () => {
    const root = await makeTempDir()
    const path = join(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    await writeFile(path, `${userRecord(0, 'question')}\n${assistantRecord(1, 'partial answer')}`)

    const first = await cachedParse(path)
    expect(first?.messageCount).toBe(2)
    expect(first).toEqual(await freshParse(path))

    await appendFile(path, `\n${userRecord(2, 'follow-up')}\n`)
    const second = await cachedParse(path)
    expect(second?.messageCount).toBe(3)
    expect(second).toEqual(await freshParse(path))
  })

  it('falls back to a full parse when the file is truncated', async () => {
    const root = await makeTempDir()
    const path = join(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    await writeFile(
      path,
      `${[userRecord(0, 'one'), assistantRecord(1, 'two'), userRecord(2, 'three')].join('\n')}\n`
    )
    await cachedParse(path)

    await writeFile(path, `${userRecord(0, 'rewritten only line')}\n`)
    const stats = createSessionParseStats()
    const reparsed = await parseAgentSessionFileCached(
      await claudeCandidate(path),
      process.platform,
      stats
    )
    expect(stats.fullParses).toBe(1)
    expect(stats.incremental).toBe(0)
    expect(reparsed).toEqual(await freshParse(path))
    expect(reparsed?.messageCount).toBe(1)
  })

  it('detects a grown rewrite via the resume-point newline guard', async () => {
    const root = await makeTempDir()
    const path = join(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    const original = `${userRecord(0, 'aa')}\n`
    await writeFile(path, original)
    await cachedParse(path)

    const rewritten = `${userRecord(0, 'a much longer rewritten question than before')}\n${assistantRecord(1, 'answer')}\n`
    expect(rewritten.length).toBeGreaterThan(original.length)
    expect(rewritten[original.length - 1]).not.toBe('\n')
    await writeFile(path, rewritten)

    const stats = createSessionParseStats()
    const reparsed = await parseAgentSessionFileCached(
      await claudeCandidate(path),
      process.platform,
      stats
    )
    expect(stats.fullParses).toBe(1)
    expect(stats.incremental).toBe(0)
    expect(reparsed).toEqual(await freshParse(path))
    expect(reparsed?.messageCount).toBe(2)
  })

  it('parses CRLF transcripts identically to the streaming parser', async () => {
    const root = await makeTempDir()
    const path = join(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    await writeFile(
      path,
      `${userRecord(0, 'windows question')}\r\n${assistantRecord(1, 'answer')}\r\n`
    )

    const first = await cachedParse(path)
    expect(first).toEqual(await freshParse(path))
    expect(first?.messageCount).toBe(2)

    await appendFile(path, `${userRecord(2, 'more')}\r\n`)
    const second = await cachedParse(path)
    expect(second?.messageCount).toBe(3)
    expect(second).toEqual(await freshParse(path))
  })

  it('caches non-Claude sessions by mtime and size', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, '2026', '05', '01'), { recursive: true })
    const path = join(
      root,
      '2026',
      '05',
      '01',
      'rollout-2026-05-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl'
    )
    await writeFile(
      path,
      `${JSON.stringify({
        timestamp: '2026-05-01T11:00:00.000Z',
        type: 'session_meta',
        payload: { id: '019f0000-1111-7222-8333-444444444444', cwd: '/repo/app' }
      })}\n`
    )
    const fileStat = await stat(path)
    const candidate: SessionFileCandidate = {
      agent: 'codex',
      file: {
        path,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: fileStat.mtime.toISOString(),
        sizeBytes: fileStat.size
      },
      codexHome: null
    }
    const stats = createSessionParseStats()
    const first = await parseAgentSessionFileCached(candidate, process.platform, stats)
    const second = await parseAgentSessionFileCached(candidate, process.platform, stats)
    expect(second).toBe(first)
    expect(stats.fullParses).toBe(1)
    expect(stats.reused).toBe(1)
  })

  it('stores nothing for a parse cancelled before it reads', async () => {
    const root = await makeTempDir()
    const path = join(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    await writeFile(path, `${[userRecord(0, 'q'), assistantRecord(1, 'a')].join('\n')}\n`)
    const candidate = await claudeCandidate(path)

    await expect(
      parseAgentSessionFileCached(
        candidate,
        process.platform,
        undefined,
        undefined,
        AbortSignal.abort()
      )
    ).rejects.toSatisfy(isAiVaultScanCancelledError)
    expect(getSessionParseCacheEntry(path)).toBeUndefined()

    expect(await cachedParse(path)).toEqual(await freshParse(path))
  })

  it('keeps the earlier resume point when an append read is cancelled part way', async () => {
    const root = await makeTempDir()
    const path = join(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    await writeFile(path, `${[userRecord(0, 'q'), assistantRecord(1, 'a')].join('\n')}\n`)
    await cachedParse(path)
    const before = getSessionParseCacheEntry(path)
    const beforeOffset = before?.resume?.byteOffset

    // Several stream chunks, so the cancel lands with most of the append unread.
    const filler = 'x'.repeat(2_000)
    await appendFile(
      path,
      `${Array.from({ length: 200 }, (_, index) => userRecord(index + 2, `${index} ${filler}`)).join('\n')}\n`
    )
    const controller = new AbortController()
    const outcomes: TranscriptReadOutcome[] = []
    let messages = 0
    const unregister = registerTranscriptConsumer({
      beginRead: () => ({
        message: () => {
          messages += 1
          controller.abort()
        },
        finish: (outcome) => outcomes.push(outcome)
      })
    })
    await expect(
      parseAgentSessionFileCached(
        await claudeCandidate(path),
        process.platform,
        undefined,
        undefined,
        controller.signal
      )
    ).rejects.toSatisfy(isAiVaultScanCancelledError)
    unregister()

    expect(messages).toBeLessThan(200)
    expect(outcomes).toEqual([
      expect.objectContaining({ incomplete: true, cancelled: true, session: null })
    ])
    expect(getSessionParseCacheEntry(path)).toBe(before)
    expect(getSessionParseCacheEntry(path)?.resume?.byteOffset).toBe(beforeOffset)

    const stats = createSessionParseStats()
    const resumed = await parseAgentSessionFileCached(
      await claudeCandidate(path),
      process.platform,
      stats
    )
    expect(stats.incremental).toBe(1)
    expect(resumed).toEqual(await freshParse(path))
    expect(resumed?.messageCount).toBe(202)
  })

  it('keeps one row each when Pi and OMP list the same transcript', async () => {
    const root = await makeTempDir()
    const path = join(root, '2026-04-20T00-00-00-000Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({
          type: 'session',
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          timestamp: '2026-04-20T00:00:00.000Z',
          cwd: '/repo/app'
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-04-20T00:01:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'shared dir prompt' }] }
        }),
        ''
      ].join('\n')
    )
    const { file } = await claudeCandidate(path)
    const stats = createSessionParseStats()
    const scan = (): Promise<(string | undefined)[]> =>
      Promise.all(
        (['omp', 'pi'] as const).map(
          async (agent) =>
            (await parseAgentSessionFileCached({ agent, file, codexHome: null }, 'linux', stats))
              ?.agent
        )
      )

    expect(await scan()).toEqual(['omp', 'pi'])
    expect(await scan()).toEqual(['omp', 'pi'])
    expect(stats.fullParses).toBe(2)
    expect(stats.reused).toBe(2)
  })
})
