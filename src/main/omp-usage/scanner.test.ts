import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageSourceCacheRef } from '../usage/usage-source-cache-file'
import { scanOmpUsageFiles } from './scanner'

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
    const padding = Array.from({ length: 160 }, (_, index) => ({
      type: 'title',
      title: `padding-${index}-${'x'.repeat(200)}`
    }))
    const file = await writeSession('slug-resume', [
      sessionRecord('resume-session', worktreePath, localTimestamp(10, 5, 9, 0)),
      ...padding,
      usageMessage({
        timestamp: localTimestamp(10, 5, 9, 5),
        model: 'glm-5.4',
        provider: 'giga-osa',
        input: 100,
        output: 10,
        costTotal: 0.001
      })
    ])

    const first = await scanOmpUsageFiles(worktrees(), sourceCache)
    expect(first.sessions).toHaveLength(1)
    expect(first.sessions[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110
    })
    const firstSources = JSON.parse(await readFile(sourceCache.path, 'utf-8')) as {
      sources: { path: string; parseResumeState?: { parsedBytes: number } | null }[]
    }
    expect(firstSources.sources[0]?.parseResumeState?.parsedBytes).toBe((await stat(file)).size)

    await appendFile(
      file,
      toJsonl([
        usageMessage({
          timestamp: localTimestamp(10, 6, 10, 0),
          input: 200,
          output: 20,
          reasoning: 5,
          costTotal: 0.002
        })
      ])
    )

    const second = await scanOmpUsageFiles(worktrees(), sourceCache)
    expect(second.sessions[0]).toMatchObject({
      startedAt: localTimestamp(10, 5, 9, 0),
      endedAt: localTimestamp(10, 6, 10, 0),
      model: 'glm-5.4',
      inputTokens: 300,
      outputTokens: 30,
      reasoningTokens: 5,
      totalTokens: 330
    })
    expect(second.sessions[0]?.costUsd).toBeCloseTo(0.003, 10)
    expect(second.dailyAggregates.map((aggregate) => aggregate.day)).toEqual([
      localDay(10, 5),
      localDay(10, 6)
    ])
    const secondSources = JSON.parse(await readFile(sourceCache.path, 'utf-8')) as {
      sources: { path: string; parseResumeState?: { parsedBytes: number } | null }[]
    }
    expect(secondSources.sources[0]?.parseResumeState?.parsedBytes).toBe((await stat(file)).size)

    const third = await scanOmpUsageFiles(worktrees(), sourceCache)
    expect(third.sessions[0]).toMatchObject({ totalTokens: 330 })
    expect(third.dailyAggregates).toEqual(second.dailyAggregates)
  })
})
