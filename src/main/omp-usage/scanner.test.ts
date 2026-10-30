import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageSourceCacheRef } from '../usage/usage-source-cache-file'
import { mergeAppendedFile } from './omp-usage-aggregation'
import { scanOmpUsageFiles } from './scanner'
import type { OmpUsagePersistedFile, OmpUsageSession } from './types'

type RawLine = Record<string, unknown> | string

function localTimestamp(month: number, day: number, hour: number, minute: number): string {
  return new Date(2026, month - 1, day, hour, minute).toISOString()
}

function localDay(month: number, day: number): string {
  const date = new Date(2026, month - 1, day, 12, 0)
  const monthText = String(date.getMonth() + 1).padStart(2, '0')
  const dayText = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${monthText}-${dayText}`
}

function toJsonl(lines: RawLine[]): string {
  return `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`
}

function sessionRecord(id: string, cwd: string, timestamp: string): Record<string, unknown> {
  return { type: 'session', version: 3, id, timestamp, cwd }
}

function usageMessage(input: {
  timestamp: string
  model?: string
  provider?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  fileTotalTokens?: number
  costTotal?: number
}): Record<string, unknown> {
  return {
    type: 'message',
    timestamp: input.timestamp,
    message: {
      role: 'assistant',
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      usage: {
        input: input.input ?? 0,
        output: input.output ?? 0,
        cacheRead: input.cacheRead ?? 0,
        cacheWrite: input.cacheWrite ?? 0,
        totalTokens: input.fileTotalTokens ?? 0,
        reasoningTokens: input.reasoning ?? 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: input.costTotal ?? 0
        }
      }
    }
  }
}

describe('scanOmpUsageFiles', () => {
  let root: string
  let sessionsDir: string
  let worktreePath: string
  let sourceCache: UsageSourceCacheRef

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-omp-usage-')))
    sessionsDir = join(root, 'sessions')
    worktreePath = join(root, 'repo')
    await mkdir(worktreePath, { recursive: true })
    vi.stubEnv('OMP_CODING_AGENT_DIR', sessionsDir)
    sourceCache = {
      path: join(root, 'orca-omp-usage-sources.json'),
      schemaVersion: 1,
      worktreeFingerprint: 'worktrees-v1',
      reuse: true
    }
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  function worktrees() {
    return [{ repoId: 'repo-1', worktreeId: 'wt-1', path: worktreePath, displayName: 'repo/main' }]
  }

  async function writeSession(slug: string, lines: RawLine[], trailing = ''): Promise<string> {
    const dir = join(sessionsDir, slug)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'session.jsonl')
    await writeFile(file, `${toJsonl(lines)}${trailing}`)
    return file
  }

  it('aggregates usage, separates reasoning, and attributes the session worktree', async () => {
    await writeSession(
      'slug-repo',
      [
        sessionRecord('session-a', worktreePath, localTimestamp(10, 1, 9, 0)),
        { type: 'title', title: 'Session A' },
        usageMessage({
          timestamp: localTimestamp(10, 1, 9, 1),
          model: 'glm-5.3',
          provider: 'giga-osa',
          input: 1000,
          output: 100,
          cacheRead: 200,
          cacheWrite: 50,
          reasoning: 25,
          fileTotalTokens: 99_999,
          costTotal: 0.01
        }),
        '{"type":"message","message":{"role":"assistant",',
        usageMessage({
          timestamp: localTimestamp(10, 1, 9, 2),
          model: 'glm-5.3',
          provider: 'giga-osa'
        }),
        { type: 'model_change', timestamp: localTimestamp(10, 1, 9, 3), model: 'glm-5.4' },
        usageMessage({
          timestamp: localTimestamp(10, 2, 10, 0),
          input: 500,
          output: 50,
          reasoning: 10,
          costTotal: 0.02
        })
      ],
      '{"type":"message","message":{"role":"assistant","usage":{"input":777'
    )
    await writeSession('slug-other', [
      sessionRecord('session-b', '/elsewhere/project', localTimestamp(10, 3, 8, 0)),
      { type: 'model_change', timestamp: localTimestamp(10, 3, 8, 0), model: 'ignored-model' },
      usageMessage({
        timestamp: localTimestamp(10, 3, 8, 1),
        model: 'glm-5.3-flash',
        provider: 'other-provider',
        input: 7,
        output: 3,
        reasoning: 2,
        costTotal: 0.0005
      })
    ])
    await writeSession('slug-empty', [
      sessionRecord('session-c', worktreePath, localTimestamp(10, 3, 9, 0)),
      usageMessage({
        timestamp: localTimestamp(10, 3, 9, 1),
        model: 'glm-5.3',
        provider: 'giga-osa'
      })
    ])

    const result = await scanOmpUsageFiles(worktrees(), sourceCache)

    expect(result.sessions.map((session) => session.sessionId).sort()).toEqual([
      'session-a',
      'session-b'
    ])
    const sessionA = result.sessions.find((session) => session.sessionId === 'session-a')
    expect(sessionA).toMatchObject({
      startedAt: localTimestamp(10, 1, 9, 0),
      endedAt: localTimestamp(10, 2, 10, 0),
      cwd: worktreePath,
      model: 'glm-5.4',
      provider: 'giga-osa',
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      inputTokens: 1500,
      outputTokens: 150,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
      reasoningTokens: 35,
      totalTokens: 1900
    })
    expect(sessionA?.costUsd).toBeCloseTo(0.03, 10)

    const sessionB = result.sessions.find((session) => session.sessionId === 'session-b')
    expect(sessionB).toMatchObject({
      cwd: '/elsewhere/project',
      model: 'glm-5.3-flash',
      provider: 'other-provider',
      inputTokens: 7,
      outputTokens: 3,
      reasoningTokens: 2,
      totalTokens: 10
    })
    expect(sessionB?.repoId).toBeUndefined()
    expect(sessionB?.worktreeId).toBeUndefined()

    expect(result.dailyAggregates.map(({ costUsd: _costUsd, ...metrics }) => metrics)).toEqual([
      {
        day: localDay(10, 1),
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 200,
        cacheWriteTokens: 50,
        reasoningTokens: 25,
        totalTokens: 1350
      },
      {
        day: localDay(10, 2),
        inputTokens: 500,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 10,
        totalTokens: 550
      },
      {
        day: localDay(10, 3),
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 2,
        totalTokens: 10
      }
    ])
    expect(result.dailyAggregates.map((aggregate) => aggregate.costUsd)).toEqual([
      expect.closeTo(0.01, 10),
      expect.closeTo(0.02, 10),
      expect.closeTo(0.0005, 10)
    ])
  })

  it('resumes appended files from the persisted byte offset', async () => {
    const padding = (tag: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        type: 'title',
        title: `${tag}-${index}-${'x'.repeat(200)}`
      }))
    const parsedLine = JSON.stringify(
      usageMessage({
        timestamp: localTimestamp(10, 5, 9, 5),
        model: 'glm-5.4',
        provider: 'giga-osa',
        input: 100,
        output: 10,
        costTotal: 0.001
      })
    )
    // Differs only in equal-width token counts, so an in-place rewrite keeps the byte length.
    const editedLine = JSON.stringify(
      usageMessage({
        timestamp: localTimestamp(10, 5, 9, 5),
        model: 'glm-5.4',
        provider: 'giga-osa',
        input: 900,
        output: 90,
        costTotal: 0.001
      })
    )
    expect(Buffer.byteLength(editedLine)).toBe(Buffer.byteLength(parsedLine))

    const file = await writeSession('slug-resume', [
      sessionRecord('resume-session', worktreePath, localTimestamp(10, 5, 9, 0)),
      ...padding('head', 60),
      parsedLine,
      ...padding('tail', 60),
      usageMessage({
        timestamp: localTimestamp(10, 6, 10, 0),
        input: 200,
        output: 20,
        costTotal: 0.002
      })
    ])

    const first = await scanOmpUsageFiles(worktrees(), sourceCache)
    expect(first.sessions[0]).toMatchObject({
      inputTokens: 300,
      outputTokens: 30,
      totalTokens: 330
    })
    const firstSources = JSON.parse(await readFile(sourceCache.path, 'utf-8')) as {
      sources: { mtimeMs: number; parseResumeState?: { parsedBytes: number } | null }[]
    }
    expect(firstSources.sources[0]?.parseResumeState?.parsedBytes).toBe((await stat(file)).size)

    // A same-size mid-file rewrite only moves mtime; a resumed scan keeps the parsed totals.
    const original = await readFile(file, 'utf-8')
    const rewritten = original.replace(parsedLine, editedLine)
    expect(rewritten).not.toBe(original)
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original))
    await writeFile(file, rewritten)
    await utimes(file, new Date(), new Date(Date.now() + 2_000))
    expect((await stat(file)).mtimeMs).not.toBe(firstSources.sources[0]?.mtimeMs)

    const second = await scanOmpUsageFiles(worktrees(), sourceCache)
    expect(second.sessions[0]).toMatchObject({
      startedAt: localTimestamp(10, 5, 9, 0),
      endedAt: localTimestamp(10, 6, 10, 0),
      model: 'glm-5.4',
      inputTokens: 300,
      outputTokens: 30,
      totalTokens: 330
    })
    expect(second.dailyAggregates.map((aggregate) => aggregate.day)).toEqual([
      localDay(10, 5),
      localDay(10, 6)
    ])

    await appendFile(
      file,
      toJsonl([
        usageMessage({
          timestamp: localTimestamp(10, 7, 11, 0),
          input: 50,
          output: 5,
          reasoning: 2,
          costTotal: 0.0005
        })
      ])
    )

    const third = await scanOmpUsageFiles(worktrees(), sourceCache)
    expect(third.sessions[0]).toMatchObject({
      endedAt: localTimestamp(10, 7, 11, 0),
      inputTokens: 350,
      outputTokens: 35,
      reasoningTokens: 2,
      totalTokens: 385
    })
    expect(third.sessions[0]?.costUsd).toBeCloseTo(0.0035, 10)
    expect(third.dailyAggregates.map((aggregate) => aggregate.day)).toEqual([
      localDay(10, 5),
      localDay(10, 6),
      localDay(10, 7)
    ])
    const thirdSources = JSON.parse(await readFile(sourceCache.path, 'utf-8')) as {
      sources: { parseResumeState?: { parsedBytes: number } | null }[]
    }
    expect(thirdSources.sources[0]?.parseResumeState?.parsedBytes).toBe((await stat(file)).size)
  })

  it('counts a usage line once after its partial write completes', async () => {
    const line = JSON.stringify(
      usageMessage({
        timestamp: localTimestamp(10, 9, 9, 1),
        model: 'glm-5.4',
        provider: 'giga-osa',
        input: 40,
        output: 4,
        costTotal: 0.0004
      })
    )
    const splitAt = Math.floor(line.length / 2)
    const file = await writeSession(
      'slug-partial',
      [sessionRecord('partial-session', worktreePath, localTimestamp(10, 9, 9, 0))],
      line.slice(0, splitAt)
    )

    const first = await scanOmpUsageFiles(worktrees(), sourceCache)
    expect(first.sessions).toHaveLength(0)

    await appendFile(file, `${line.slice(splitAt)}\n`)
    const second = await scanOmpUsageFiles(worktrees(), sourceCache)
    expect(second.sessions).toHaveLength(1)
    expect(second.sessions[0]).toMatchObject({
      sessionId: 'partial-session',
      inputTokens: 40,
      outputTokens: 4,
      totalTokens: 44
    })
    expect(second.dailyAggregates).toHaveLength(1)
    expect(second.dailyAggregates[0]).toMatchObject({
      inputTokens: 40,
      outputTokens: 4,
      totalTokens: 44
    })

    const third = await scanOmpUsageFiles(worktrees(), sourceCache)
    expect(third.sessions[0]).toMatchObject({ totalTokens: 44 })
    expect(third.dailyAggregates).toEqual(second.dailyAggregates)
  })

  it('reparses from scratch when a rewritten file invalidates the checkpoint', async () => {
    const padding = (tag: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        type: 'title',
        title: `${tag}-${index}-${'x'.repeat(200)}`
      }))
    const file = await writeSession('slug-rewrite', [
      sessionRecord('old-session', worktreePath, localTimestamp(10, 7, 9, 0)),
      ...padding('old', 60),
      usageMessage({
        timestamp: localTimestamp(10, 7, 9, 5),
        model: 'glm-5.4',
        provider: 'giga-osa',
        input: 100,
        output: 10,
        costTotal: 0.001
      })
    ])

    const first = await scanOmpUsageFiles(worktrees(), sourceCache)
    expect(first.sessions[0]).toMatchObject({
      sessionId: 'old-session',
      repoId: 'repo-1',
      totalTokens: 110
    })

    const replacement = toJsonl([
      sessionRecord('new-session', '/elsewhere/project', localTimestamp(10, 8, 8, 0)),
      ...padding('new', 40),
      usageMessage({
        timestamp: localTimestamp(10, 8, 8, 5),
        model: 'glm-5.4',
        provider: 'other-provider',
        input: 5,
        output: 1,
        costTotal: 0.0001
      })
    ])
    expect(Buffer.byteLength(replacement)).toBeLessThan((await stat(file)).size)
    await writeFile(file, replacement)

    const second = await scanOmpUsageFiles(worktrees(), sourceCache)
    expect(second.sessions).toHaveLength(1)
    expect(second.sessions[0]).toMatchObject({
      sessionId: 'new-session',
      provider: 'other-provider',
      inputTokens: 5,
      outputTokens: 1,
      totalTokens: 6
    })
    expect(second.sessions[0]?.repoId).toBeUndefined()
    expect(second.dailyAggregates.map((aggregate) => aggregate.day)).toEqual([localDay(10, 8)])
  })

  it('accumulates cross-boundary sessions across repeated resumes', async () => {
    const padding = Array.from({ length: 60 }, (_, index) => ({
      type: 'title',
      title: `padding-${index}-${'x'.repeat(200)}`
    }))
    const file = await writeSession('slug-accumulate', [
      sessionRecord('session-a', worktreePath, localTimestamp(10, 12, 9, 0)),
      ...padding,
      usageMessage({
        timestamp: localTimestamp(10, 12, 9, 5),
        model: 'glm-5.4',
        provider: 'giga-osa',
        input: 100,
        output: 10,
        costTotal: 0.001
      })
    ])
    await scanOmpUsageFiles(worktrees(), sourceCache)

    await appendFile(
      file,
      toJsonl([
        sessionRecord('session-b', worktreePath, localTimestamp(10, 13, 9, 0)),
        usageMessage({
          timestamp: localTimestamp(10, 13, 9, 5),
          model: 'glm-5.4',
          provider: 'giga-osa',
          input: 200,
          output: 20,
          costTotal: 0.002
        })
      ])
    )
    const second = await scanOmpUsageFiles(worktrees(), sourceCache)
    expect(second.sessions.map((session) => session.sessionId).sort()).toEqual([
      'session-a',
      'session-b'
    ])

    await appendFile(
      file,
      toJsonl([
        usageMessage({
          timestamp: localTimestamp(10, 14, 9, 5),
          model: 'glm-5.4',
          provider: 'giga-osa',
          input: 50,
          output: 5,
          costTotal: 0.0005
        })
      ])
    )
    const third = await scanOmpUsageFiles(worktrees(), sourceCache)
    const byId = new Map(third.sessions.map((session) => [session.sessionId, session]))
    expect(byId.get('session-a')).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110
    })
    expect(byId.get('session-b')).toMatchObject({
      inputTokens: 250,
      outputTokens: 25,
      totalTokens: 275
    })
    const cumulativeSessionTokens = third.sessions.reduce(
      (sum, session) => sum + session.totalTokens,
      0
    )
    const cumulativeDailyTokens = third.dailyAggregates.reduce(
      (sum, aggregate) => sum + aggregate.totalTokens,
      0
    )
    expect(cumulativeSessionTokens).toBe(cumulativeDailyTokens)
    expect(cumulativeSessionTokens).toBe(385)
  })
})

describe('mergeAppendedFile', () => {
  const session = (overrides: Partial<OmpUsageSession>): OmpUsageSession => ({
    sessionId: 'session-a',
    startedAt: localTimestamp(10, 10, 9, 0),
    endedAt: localTimestamp(10, 10, 9, 5),
    cwd: '/repo',
    model: 'glm-5.4',
    provider: 'giga-osa',
    inputTokens: 10,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 11,
    costUsd: 0.001,
    ...overrides
  })
  const persistedFile = (
    overrides: Partial<OmpUsagePersistedFile>,
    sessionOverrides: Partial<OmpUsageSession>
  ): OmpUsagePersistedFile => ({
    path: '/repo/session.jsonl',
    mtimeMs: 1,
    size: 10,
    sessions: [session(sessionOverrides)],
    dailyAggregates: [],
    ...overrides
  })

  it('combines a same-identified appended session', () => {
    const merged = mergeAppendedFile(
      persistedFile({}, {}),
      persistedFile(
        { mtimeMs: 2, size: 20 },
        { startedAt: localTimestamp(10, 11, 9, 0), endedAt: localTimestamp(10, 11, 9, 5) }
      )
    )

    expect(merged.sessions).toHaveLength(1)
    expect(merged.sessions[0]).toMatchObject({
      sessionId: 'session-a',
      startedAt: localTimestamp(10, 10, 9, 0),
      endedAt: localTimestamp(10, 11, 9, 5),
      inputTokens: 20,
      outputTokens: 2,
      totalTokens: 22
    })
  })

  it('keeps a differently identified appended session instead of combining ids', () => {
    const merged = mergeAppendedFile(
      persistedFile({}, {}),
      persistedFile(
        { mtimeMs: 2, size: 20 },
        {
          sessionId: 'session-b',
          startedAt: localTimestamp(10, 11, 9, 0),
          endedAt: localTimestamp(10, 11, 9, 5),
          inputTokens: 20,
          outputTokens: 2,
          reasoningTokens: 3,
          totalTokens: 22,
          costUsd: 0.002
        }
      )
    )

    expect(merged.sessions.map((entry) => entry.sessionId)).toEqual(['session-a', 'session-b'])
    expect(merged.sessions[1]).toMatchObject({
      inputTokens: 20,
      outputTokens: 2,
      reasoningTokens: 3,
      totalTokens: 22
    })
  })

  it('merges an appended delta into a matching cached session anywhere in the list', () => {
    const merged = mergeAppendedFile(
      {
        path: '/repo/session.jsonl',
        mtimeMs: 1,
        size: 10,
        sessions: [
          session({ sessionId: 'session-a' }),
          session({
            sessionId: 'session-b',
            inputTokens: 20,
            outputTokens: 2,
            totalTokens: 22,
            costUsd: 0.002
          })
        ],
        dailyAggregates: []
      },
      persistedFile(
        { mtimeMs: 2, size: 20 },
        {
          sessionId: 'session-b',
          startedAt: localTimestamp(10, 13, 9, 0),
          endedAt: localTimestamp(10, 13, 9, 5),
          inputTokens: 5,
          outputTokens: 1,
          totalTokens: 6,
          costUsd: 0.0005
        }
      )
    )

    expect(merged.sessions.map((entry) => entry.sessionId)).toEqual(['session-a', 'session-b'])
    expect(merged.sessions[1]).toMatchObject({
      inputTokens: 25,
      outputTokens: 3,
      totalTokens: 28
    })
    expect(merged.sessions[1]?.costUsd).toBeCloseTo(0.0025, 10)
  })
})
