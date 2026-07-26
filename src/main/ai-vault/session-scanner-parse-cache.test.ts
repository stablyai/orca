import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests,
  createSessionParseStats
} from './session-scanner-parse-cache'
import { parseClaudeSessionFile } from './session-scanner-primary-parsers'
import type { FileWithMtime, SessionFileCandidate } from './session-scanner-types'

let tempRoots: string[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
})

afterEach(async () => {
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

// Ground truth: what a cold one-shot parse of the current file contents yields.
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

  it('shows a trailing unterminated line without double-counting it later', async () => {
    const root = await makeTempDir()
    const path = join(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    // Final record has no trailing newline (mid-write file).
    await writeFile(path, `${userRecord(0, 'question')}\n${assistantRecord(1, 'partial answer')}`)

    const first = await cachedParse(path)
    expect(first?.messageCount).toBe(2)
    expect(first).toEqual(await freshParse(path))

    // The writer finishes the line and appends one more record.
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

    // Larger file whose byte at the old resume point is mid-line, not '\n'.
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
})
