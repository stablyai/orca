import { describe, expect, it, vi } from 'vitest'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { parseCodexUsageRecord } from './codex-usage-record-parser'

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
      eventKey: expect.any(String),
      cwd: '/workspace/repo/packages/app',
      model: 'gpt-5.2-codex',
      hasInferredPricing: false,
      longContextInputTokens: 0,
      longContextCachedInputTokens: 0,
      longContextOutputTokens: 0,
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 250,
      reasoningOutputTokens: 100,
      totalTokens: 1250
    })
    expect(duplicate).toBeNull()
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
