import { describe, expect, it } from 'vitest'
import { attributeCodexUsageEvent, parseCodexUsageRecord } from './scanner'

describe('parseCodexUsageRecord', () => {
  it('uses token totals only as a duplicate baseline', () => {
    const context = {
      sessionId: 'session-1',
      sessionCwd: null,
      currentCwd: null,
      currentModel: null,
      previousTotals: null
    }

    expect(
      parseCodexUsageRecord(
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-1', cwd: '/workspace/repo' }
        }),
        context
      )
    ).toBeNull()

    expect(
      parseCodexUsageRecord(
        JSON.stringify({
          type: 'turn_context',
          payload: { cwd: '/workspace/repo/packages/app', model: 'gpt-5.2-codex' }
        }),
        context
      )
    ).toBeNull()

    const first = parseCodexUsageRecord(
      JSON.stringify({
        timestamp: '2026-04-09T10:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 400,
              output_tokens: 250,
              reasoning_output_tokens: 100,
              total_tokens: 1250
            },
            last_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 400,
              output_tokens: 250,
              reasoning_output_tokens: 100,
              total_tokens: 1250
            }
          }
        }
      }),
      context
    )

    const duplicate = parseCodexUsageRecord(
      JSON.stringify({
        timestamp: '2026-04-09T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 400,
              output_tokens: 250,
              reasoning_output_tokens: 100,
              total_tokens: 1250
            },
            last_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 400,
              output_tokens: 250,
              reasoning_output_tokens: 100,
              total_tokens: 1250
            }
          }
        }
      }),
      context
    )

    expect(first).toEqual({
      sessionId: 'session-1',
      timestamp: '2026-04-09T10:00:00.000Z',
      cwd: '/workspace/repo/packages/app',
      model: 'gpt-5.2-codex',
      hasInferredPricing: false,
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 250,
      reasoningOutputTokens: 100,
      totalTokens: 1250
    })
    expect(duplicate).toBeNull()
  })

  it('preserves unknown model metadata instead of assigning fallback pricing', () => {
    const context = {
      sessionId: 'session-1',
      sessionCwd: '/workspace/repo',
      currentCwd: '/workspace/repo',
      currentModel: null,
      previousTotals: null
    }

    const parsed = parseCodexUsageRecord(
      JSON.stringify({
        timestamp: '2026-04-09T10:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 20,
              output_tokens: 50,
              reasoning_output_tokens: 10,
              total_tokens: 170
            }
          }
        }
      }),
      context
    )

    expect(parsed?.model).toBeNull()
    expect(parsed?.hasInferredPricing).toBe(true)
  })

  it('uses last token usage for the first resumed-session event', () => {
    const context = {
      sessionId: 'session-1',
      sessionCwd: '/workspace/repo',
      currentCwd: '/workspace/repo',
      currentModel: 'gpt-5.5',
      previousTotals: null
    }

    const parsed = parseCodexUsageRecord(
      JSON.stringify({
        timestamp: '2026-04-09T10:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 50_000,
              cached_input_tokens: 40_000,
              output_tokens: 5_000,
              reasoning_output_tokens: 1_000,
              total_tokens: 55_000
            },
            last_token_usage: {
              input_tokens: 2_000,
              cached_input_tokens: 1_500,
              output_tokens: 500,
              reasoning_output_tokens: 100,
              total_tokens: 2_500
            }
          }
        }
      }),
      context
    )

    expect(parsed).toMatchObject({
      inputTokens: 2_000,
      cachedInputTokens: 1_500,
      outputTokens: 500,
      reasoningOutputTokens: 100,
      totalTokens: 2_500
    })
  })
})

describe('attributeCodexUsageEvent', () => {
  it('attributes nested cwd paths to the nearest containing worktree', async () => {
    const attributed = await attributeCodexUsageEvent(
      {
        sessionId: 'session-1',
        timestamp: '2026-04-09T10:00:00.000Z',
        cwd: '/workspace/repo/app2/subdir',
        model: 'gpt-5.2-codex',
        hasInferredPricing: false,
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 25,
        reasoningOutputTokens: 10,
        totalTokens: 125
      },
      [
        {
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo/app',
          path: '/workspace/repo/app',
          displayName: 'App',
          canonicalPath: '/workspace/repo/app'
        },
        {
          repoId: 'repo-2',
          worktreeId: 'repo-2::/workspace/repo/app2',
          path: '/workspace/repo/app2',
          displayName: 'App 2',
          canonicalPath: '/workspace/repo/app2'
        }
      ]
    )

    expect(attributed?.projectKey).toBe('worktree:repo-2::/workspace/repo/app2')
    expect(attributed?.projectLabel).toBe('App 2')
    expect(attributed?.worktreeId).toBe('repo-2::/workspace/repo/app2')
  })

  it('does not treat different Windows drives as containing paths', async () => {
    const attributed = await attributeCodexUsageEvent(
      {
        sessionId: 'session-1',
        timestamp: '2026-04-09T10:00:00.000Z',
        cwd: 'D:\\other\\repo',
        model: 'gpt-5.2-codex',
        hasInferredPricing: false,
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 25,
        reasoningOutputTokens: 10,
        totalTokens: 125
      },
      [
        {
          repoId: 'repo-1',
          worktreeId: 'repo-1::C:\\repo',
          path: 'C:\\repo',
          displayName: 'Repo',
          canonicalPath: 'C:\\repo'
        }
      ]
    )

    expect(attributed?.projectKey).toBe('cwd:d:/other/repo')
    expect(attributed?.worktreeId).toBeNull()
  })
})
