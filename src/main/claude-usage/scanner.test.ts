import { describe, expect, it } from 'vitest'
import { parseClaudeUsageFile, parseClaudeUsageRecord } from './transcript-record-parser'
import { attributeClaudeUsageTurns } from './worktree-attribution'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('parseClaudeUsageRecord', () => {
  it('clamps a 1-hour breakdown that exceeds the reported cache-write total', () => {
    const parsed = parseClaudeUsageRecord(
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-1',
        timestamp: '2026-04-09T10:00:00.000Z',
        message: {
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 100,
            output_tokens: 25,
            cache_creation_input_tokens: 100,
            cache_creation: { ephemeral_1h_input_tokens: 400 }
          }
        }
      })
    )

    expect(parsed?.cacheWriteTokens).toBe(100)
    expect(parsed?.cacheWrite1hTokens).toBe(100)
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
          cacheWriteTokens: 7,
          cacheWrite1hTokens: 0
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Claude usage aggregation', () => {
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
          cacheWriteTokens: 5,
          cacheWrite1hTokens: 0
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
