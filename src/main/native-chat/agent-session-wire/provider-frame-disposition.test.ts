import { describe, expect, it } from 'vitest'
import { CODEX_APP_SERVER_NOTIFICATION_METHODS } from '../../codex/codex-app-server-notification-schema'
import { CLAUDE_STREAM_JSON_FRAME_KINDS } from './claude-stream-json-frame-schema'
import { classifyProviderFrame, PROVIDER_FRAME_CLASSIFICATIONS } from './provider-frame-disposition'

describe('provider frame classification catalog', () => {
  it('classifies every pinned Codex app-server notification method', () => {
    expect(Object.keys(PROVIDER_FRAME_CLASSIFICATIONS.codex)).toEqual([
      ...CODEX_APP_SERVER_NOTIFICATION_METHODS
    ])
  })

  it('classifies every pinned Claude stream-json frame kind', () => {
    expect(Object.keys(PROVIDER_FRAME_CLASSIFICATIONS.claude)).toEqual([
      ...CLAUDE_STREAM_JSON_FRAME_KINDS
    ])
  })

  it('suppresses benign hook lifecycle and Codex rate-limit frames', () => {
    expect(classifyProviderFrame('codex', 'notification:hook/started', {})).toBe(
      'suppressed-benign'
    )
    expect(classifyProviderFrame('codex', 'notification:hook/completed', {})).toBe(
      'suppressed-benign'
    )
    expect(classifyProviderFrame('codex', 'notification:account/rateLimits/updated', {})).toBe(
      'suppressed-benign'
    )
    expect(classifyProviderFrame('claude', 'message:system:hook_started', {})).toBe(
      'suppressed-benign'
    )
  })

  it('promotes payload failures over a benign catalog classification', () => {
    expect(
      classifyProviderFrame('codex', 'notification:hook/completed', {
        run: { status: 'failed' }
      })
    ).toBe('error-surface')
    expect(
      classifyProviderFrame('claude', 'message:system:hook_response', {
        outcome: 'error',
        stderr: 'hook failed'
      })
    ).toBe('error-surface')
  })

  it('keeps unknown future frames on the substantive bounded fallback path', () => {
    expect(classifyProviderFrame('codex', 'notification:future/event', {})).toBe(
      'timeline-substantive'
    )
    expect(classifyProviderFrame('claude', 'message:future_event', {})).toBe('timeline-substantive')
  })
})
