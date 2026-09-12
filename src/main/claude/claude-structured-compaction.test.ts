import { afterEach, describe, expect, it, vi } from 'vitest'
import { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import { claudeUnwrittenUserMessageError } from './claude-agent-sdk-user-message-queue'
import { compactClaudeSession, isClaudeCompactionContent } from './claude-structured-compaction'
import { sessionFor } from './claude-structured-dispatch-test-support'

afterEach(() => {
  vi.useRealTimers()
})

describe('Claude compaction transcript content', () => {
  it('keeps generated summaries and command echoes out of the transcript only during explicit compaction', async () => {
    const tracker = new StructuredSessionCompaction()
    const event = {
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'user',
        session_id: 'provider',
        uuid: 'summary',
        message: { role: 'user', content: 'generated compaction summary' }
      }
    }
    expect(isClaudeCompactionContent(tracker, event)).toBe(false)
    const completion = tracker.run('orca-session', 'provider', async () => ({}))
    expect(isClaudeCompactionContent(tracker, event)).toBe(true)
    expect(isClaudeCompactionContent(tracker, { ...event, sessionId: 'other' })).toBe(false)
    expect(isClaudeCompactionContent(tracker, { ...event, message: { type: 'result' } })).toBe(
      false
    )
    tracker.ended('orca-session')
    await completion
    expect(isClaudeCompactionContent(tracker, event)).toBe(false)
  })

  it('fails a provably unwritten command without waiting for the completion deadline', async () => {
    vi.useFakeTimers()
    const session = sessionFor(
      vi.fn().mockRejectedValue(claudeUnwrittenUserMessageError(new Error('input closed')))
    )
    const pending = compactClaudeSession(session, new StructuredSessionCompaction(60_000), {
      sessionId: 'orca-session',
      fence: 1,
      turnId: 'compact-1'
    })

    await vi.advanceTimersByTimeAsync(1)

    await expect(pending).resolves.toEqual({ error: 'provider_write_failed: input closed' })
  })

  it('keeps waiting when the command write outcome is ambiguous', async () => {
    vi.useFakeTimers()
    const session = sessionFor(vi.fn().mockRejectedValue(new Error('input pump stopped')))
    const pending = compactClaudeSession(session, new StructuredSessionCompaction(10), {
      sessionId: 'orca-session',
      fence: 1,
      turnId: 'compact-1'
    })
    const rejection = expect(pending).rejects.toThrow('Compaction completion is unconfirmed.')

    await vi.advanceTimersByTimeAsync(10)

    await rejection
  })
})
