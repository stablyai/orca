import { describe, expect, it } from 'vitest'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'

// OpenCode's ACP bridge reports a scheduled retry in this meta key, and null once the next step starts.
const retry = (value: unknown) => ({
  sessionId: 'root',
  update: { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': value } }
})
const scheduled = (attempt: number) =>
  retry({
    attempt,
    nextRetryAt: '2026-11-22T00:01:00.000Z',
    error: {
      type: 'provider.rate-limit',
      message: 'Rate limit reached; retrying shortly.',
      status: 429,
      retryAfterMs: 60000
    }
  })

describe('OpenCode provider retries', () => {
  it('revises one retry notice per run of retries, and starts another after OpenCode clears it', () => {
    const lane = new AcpTimelineTranslator({ sessionId: 'root', dialect: OPENCODE_ACP_DIALECT })
    lane.openPrompt('prompt-1', 1)
    const notices = (at: number, params: unknown) =>
      lane
        .notification('session/update', params, at)
        .flatMap((event) =>
          event.type === 'item.update' && event.body.kind === 'status'
            ? [{ item: event.item, tone: event.body.tone, text: event.body.text }]
            : []
        )

    const [first] = notices(2, scheduled(3))
    expect(first).toEqual({
      item: expect.stringMatching(/^provider-retry:/),
      tone: 'warning',
      text: expect.stringContaining('Rate limit reached; retrying shortly.')
    })
    expect(first?.text).toContain('3')
    const [second] = notices(3, scheduled(4))
    expect(second?.item).toBe(first?.item)
    expect(second?.text).toContain('4')
    expect(notices(4, retry(null))).toEqual([])
    const [next] = notices(5, scheduled(1))
    expect(next?.item).toMatch(/^provider-retry:/)
    expect(next?.item).not.toBe(first?.item)
  })
})
