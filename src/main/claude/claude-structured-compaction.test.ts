import { afterEach, describe, expect, it, vi } from 'vitest'
import { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import { claudeUnwrittenUserMessageError } from './claude-agent-sdk-user-message-queue'
import { compactClaudeSession, isClaudeCompactionContent } from './claude-structured-compaction'
import { sessionFor } from './claude-structured-dispatch-test-support'

afterEach(() => {
  vi.useRealTimers()
})

const COMMAND = { turnId: 'compact:cmd-1', turnItemId: 'orca:command-turn:cmd-1' }

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
    const completion = tracker.run('orca-session', 'provider', async () => ({}), COMMAND)
    expect(isClaudeCompactionContent(tracker, event)).toBe(true)
    expect(isClaudeCompactionContent(tracker, { ...event, sessionId: 'other' })).toBe(false)
    expect(isClaudeCompactionContent(tracker, { ...event, message: { type: 'result' } })).toBe(
      false
    )
    tracker.ended('orca-session')
    await completion
    expect(isClaudeCompactionContent(tracker, event)).toBe(false)
  })

  it('fails a provably unwritten command at once', async () => {
    const session = sessionFor(
      vi.fn().mockRejectedValue(claudeUnwrittenUserMessageError(new Error('input closed')))
    )
    const pending = compactClaudeSession(session, new StructuredSessionCompaction(), {
      sessionId: 'orca-session',
      fence: 1,
      ...COMMAND
    })

    await expect(pending).resolves.toEqual({
      outcome: 'failure',
      error: 'provider_write_failed: input closed'
    })
  })

  it('keeps waiting, with no deadline, when the command write outcome is ambiguous', async () => {
    vi.useFakeTimers()
    const tracker = new StructuredSessionCompaction()
    const session = sessionFor(vi.fn().mockRejectedValue(new Error('input pump stopped')))
    const settled = vi.fn()
    void compactClaudeSession(session, tracker, { sessionId: 'orca-session', fence: 1, ...COMMAND })
      .then(settled)
      .catch(settled)

    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(settled).not.toHaveBeenCalled()
    tracker.abandon('orca-session', COMMAND.turnId)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toHaveBeenCalledWith({ outcome: 'cancellation' })
  })
})
