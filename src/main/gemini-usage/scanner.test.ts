import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { parseGeminiUsageFile, scanGeminiUsageFiles } from './scanner'
import type { GeminiUsageWorktreeRef } from './gemini-usage-event-attribution'
import type { GeminiUsagePersistedFile } from './types'

describe('gemini-usage scanner', () => {
  let testRoot: string
  let geminiTmpDir: string
  let antigravityBrainDir: string
  const originalGeminiSessionsDir = process.env.GEMINI_SESSIONS_DIR
  const originalAntigravityBrainDir = process.env.ANTIGRAVITY_BRAIN_DIR

  const mockWorktrees: (GeminiUsageWorktreeRef & { canonicalPath: string })[] = [
    {
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      path: '/workspace/project-alpha',
      canonicalPath: '/workspace/project-alpha',
      displayName: 'project-alpha'
    }
  ]

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `orca-gemini-scanner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    geminiTmpDir = join(testRoot, 'gemini-tmp')
    antigravityBrainDir = join(testRoot, 'antigravity-brain')

    process.env.GEMINI_SESSIONS_DIR = geminiTmpDir
    process.env.ANTIGRAVITY_BRAIN_DIR = antigravityBrainDir

    await mkdir(geminiTmpDir, { recursive: true })
    await mkdir(antigravityBrainDir, { recursive: true })
  })

  afterEach(async () => {
    if (originalGeminiSessionsDir !== undefined) {
      process.env.GEMINI_SESSIONS_DIR = originalGeminiSessionsDir
    } else {
      delete process.env.GEMINI_SESSIONS_DIR
    }

    if (originalAntigravityBrainDir !== undefined) {
      process.env.ANTIGRAVITY_BRAIN_DIR = originalAntigravityBrainDir
    } else {
      delete process.env.ANTIGRAVITY_BRAIN_DIR
    }

    await rm(testRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('parses a JSON session file and aggregates events to sessions and daily aggregates', async () => {
    const filePath = join(geminiTmpDir, 'session-1.json')
    await writeFile(
      filePath,
      JSON.stringify({
        sessionId: 'session-1',
        cwd: '/workspace/project-alpha/src',
        startTime: '2026-05-10T09:00:00.000Z',
        messages: [
          {
            type: 'user',
            timestamp: '2026-05-10T09:00:00.000Z',
            content: 'Write a parser'
          },
          {
            type: 'gemini',
            timestamp: '2026-05-10T09:00:30.000Z',
            model: 'gemini-2.5-pro',
            tokens: {
              input: 1000,
              cached: 200,
              output: 400,
              reasoning: 50,
              total: 1400
            }
          }
        ]
      })
    )

    const parsed = await parseGeminiUsageFile(filePath, mockWorktrees)
    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.dailyAggregates).toHaveLength(1)
    expect(parsed.ownedEventKeys).toHaveLength(1)

    const session = parsed.sessions[0]!
    expect(session.sessionId).toBe('session-1')
    expect(session.primaryModel).toBe('gemini-2.5-pro')
    expect(session.primaryWorktreeId).toBe('wt-1')
    expect(session.totalInputTokens).toBe(1000)
    expect(session.totalCachedInputTokens).toBe(200)
    expect(session.totalOutputTokens).toBe(400)
    expect(session.totalReasoningOutputTokens).toBe(50)
    expect(session.totalTokens).toBe(1450)

    const daily = parsed.dailyAggregates[0]!
    expect(daily.day).toBe('2026-05-10')
    expect(daily.inputTokens).toBe(1000)
    expect(daily.outputTokens).toBe(400)
    expect(daily.worktreeId).toBe('wt-1')
  })

  it('scans files incrementally and reuses cached previous files with matching mtime and size', async () => {
    const filePath = join(geminiTmpDir, 'session-1.jsonl')
    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'gemini',
          timestamp: '2026-05-10T09:00:30.000Z',
          model: 'gemini-2.5-flash',
          cwd: '/workspace/project-alpha',
          tokens: { input: 500, cached: 100, output: 200 }
        })
      ].join('\n')
    )

    const initialResult = await scanGeminiUsageFiles(mockWorktrees, [])
    expect(initialResult.processedFiles).toHaveLength(1)
    expect(initialResult.sessions).toHaveLength(1)
    expect(initialResult.dailyAggregates).toHaveLength(1)

    // Second scan with previous files passed: should reuse
    const secondResult = await scanGeminiUsageFiles(
      mockWorktrees,
      initialResult.processedFiles as GeminiUsagePersistedFile[]
    )
    expect(secondResult.processedFiles).toHaveLength(1)
    expect(secondResult.sessions).toHaveLength(1)
    expect(secondResult.sessions[0]?.totalTokens).toBe(700)
  })
})
