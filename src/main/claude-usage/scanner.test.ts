import { describe, expect, it } from 'vitest'
import {
  aggregateClaudeUsage,
  attributeClaudeUsageTurns,
  parseClaudeUsageFile,
  parseClaudeUsageRecord
} from './scanner'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

describe('parseClaudeUsageRecord', () => {
  it('extracts token usage from assistant transcript lines', () => {
    const parsed = parseClaudeUsageRecord(
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-1',
        timestamp: '2026-04-09T10:00:00.000Z',
        cwd: '/workspace/repo-a',
        gitBranch: 'feature/test',
        message: {
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 100,
            output_tokens: 25,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5
          }
        }
      })
    )

    expect(parsed).toEqual({
      sessionId: 'session-1',
      timestamp: '2026-04-09T10:00:00.000Z',
      model: 'claude-sonnet-4-6',
      cwd: '/workspace/repo-a',
      gitBranch: 'feature/test',
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 10,
      cacheWriteTokens: 5
    })
  })

  it('merges duplicate streamed assistant usage by message and request id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-claude-dedupe-'))
    const filePath = join(root, 'session.jsonl')
    try {
      await writeFile(
        filePath,
        [
          JSON.stringify({
            type: 'assistant',
            sessionId: 'session-1',
            timestamp: '2026-04-09T10:00:00.000Z',
            requestId: 'req-1',
            message: {
              id: 'msg-1',
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 100,
                output_tokens: 25,
                cache_read_input_tokens: 10,
                cache_creation_input_tokens: 5
              }
            }
          }),
          JSON.stringify({
            type: 'assistant',
            sessionId: 'session-1',
            timestamp: '2026-04-09T10:00:01.000Z',
            requestId: 'req-1',
            message: {
              id: 'msg-1',
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 120,
                output_tokens: 30,
                cache_read_input_tokens: 12,
                cache_creation_input_tokens: 7
              }
            }
          })
        ].join('\n')
      )

      await expect(parseClaudeUsageFile(filePath)).resolves.toEqual([
        {
          sessionId: 'session-1',
          timestamp: '2026-04-09T10:00:00.000Z',
          model: 'claude-sonnet-4-6',
          cwd: null,
          gitBranch: null,
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 12,
          cacheWriteTokens: 7
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Claude usage aggregation', () => {
  it('attributes Orca worktree usage and preserves multi-location session breakdowns', async () => {
    const attributed = await attributeClaudeUsageTurns(
      [
        {
          sessionId: 'session-1',
          timestamp: '2026-04-09T10:00:00.000Z',
          model: 'claude-sonnet-4-6',
          cwd: '/workspace/repo-a',
          gitBranch: 'feature/a',
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheWriteTokens: 5
        },
        {
          sessionId: 'session-1',
          timestamp: '2026-04-09T10:10:00.000Z',
          model: 'claude-sonnet-4-6',
          cwd: '/outside/repo-b',
          gitBranch: 'feature/b',
          inputTokens: 50,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        }
      ],
      new Map([
        [
          '/workspace/repo-a',
          {
            repoId: 'repo-1',
            worktreeId: 'repo-1::/workspace/repo-a',
            path: '/workspace/repo-a',
            displayName: 'Repo A'
          }
        ]
      ])
    )

    const aggregated = aggregateClaudeUsage(attributed)
    expect(aggregated.sessions).toHaveLength(1)
    expect(aggregated.dailyAggregates).toHaveLength(2)
    expect(aggregated.sessions[0]?.locationBreakdown).toEqual([
      {
        locationKey: 'worktree:repo-1::/workspace/repo-a',
        projectLabel: 'Repo A',
        repoId: 'repo-1',
        worktreeId: 'repo-1::/workspace/repo-a',
        turnCount: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheWriteTokens: 5
      },
      {
        locationKey: 'cwd:/outside/repo-b',
        projectLabel: 'outside/repo-b',
        repoId: null,
        worktreeId: null,
        turnCount: 1,
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      }
    ])
  })

  it('attributes nested cwd paths to the containing worktree', async () => {
    const attributed = await attributeClaudeUsageTurns(
      [
        {
          sessionId: 'session-1',
          timestamp: '2026-04-09T10:00:00.000Z',
          model: 'claude-sonnet-4-6',
          cwd: '/workspace/repo-a/packages/app',
          gitBranch: 'feature/a',
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheWriteTokens: 5
        }
      ],
      new Map([
        [
          '/workspace/repo-a',
          {
            repoId: 'repo-1',
            worktreeId: 'repo-1::/workspace/repo-a',
            path: '/workspace/repo-a',
            displayName: 'Repo A'
          }
        ]
      ])
    )

    expect(attributed[0]?.projectKey).toBe('worktree:repo-1::/workspace/repo-a')
    expect(attributed[0]?.projectLabel).toBe('Repo A')
  })
})
