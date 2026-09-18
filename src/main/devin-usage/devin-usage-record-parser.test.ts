import { describe, expect, it } from 'vitest'
import { parseDevinUsageContent } from './devin-usage-record-parser'

describe('parseDevinUsageContent', () => {
  it('reads current ATIF token buckets without losing cache usage', () => {
    const events = parseDevinUsageContent(
      JSON.stringify({
        session_id: 'devin-session',
        working_directory: '/repo/worktree',
        agent: { model_name: 'swe-1-6' },
        steps: [
          {
            role: 'assistant',
            metadata: {
              created_at: '2026-09-18T12:00:00Z',
              total_input_tokens: 10,
              output_tokens: 4,
              cache_read_tokens: 3,
              cache_creation_tokens: 2
            }
          }
        ]
      })
    )

    expect(events).toEqual([
      {
        sessionId: 'devin-session',
        timestamp: '2026-09-18T12:00:00Z',
        model: 'swe-1-6',
        cwd: '/repo/worktree',
        inputTokens: 10,
        cachedInputTokens: 5,
        outputTokens: 4,
        reasoningOutputTokens: 0,
        totalTokens: 19
      }
    ])
  })
})
