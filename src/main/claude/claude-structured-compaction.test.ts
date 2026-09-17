import { afterEach, describe, expect, it, vi } from 'vitest'
import { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import { claudeUnwrittenUserMessageError } from './claude-agent-sdk-user-message-queue'
import {
  compactClaudeSession,
  isClaudeCompactionContent,
  observeClaudeCompaction
} from './claude-structured-compaction'
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

  it('retains an interrupted command until its matching Claude lifecycle terminal', async () => {
    const session = sessionFor()
    session.capabilities = ['msg_lifecycle_v1']
    const tracker = new StructuredSessionCompaction()
    const pending = compactClaudeSession(session, tracker, {
      sessionId: 'orca-session',
      fence: 1,
      turnId: 'compact:operation-1'
    })
    const rejected = expect(pending).rejects.toThrow('interrupted')

    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const commandUuid = session.dispatchWaiters[0]!.sentUuid
    tracker.claude('orca-session', {
      type: 'command_lifecycle',
      state: 'started',
      command_uuid: commandUuid,
      session_id: 'provider-session'
    })
    tracker.interrupted('orca-session')
    await rejected

    tracker.claude('orca-session', {
      type: 'result',
      subtype: 'success',
      session_id: 'provider-session'
    })
    tracker.claude('orca-session', {
      type: 'command_lifecycle',
      state: 'completed',
      command_uuid: 'later-command',
      session_id: 'provider-session'
    })
    expect(tracker.hasPending('orca-session')).toBe(true)

    tracker.claude('orca-session', {
      type: 'command_lifecycle',
      state: 'cancelled',
      command_uuid: commandUuid,
      session_id: 'provider-session'
    })
    expect(tracker.hasPending('orca-session')).toBe(false)
  })

  it('releases interrupted transcript suppression when a later dispatched turn starts', async () => {
    const tracker = new StructuredSessionCompaction()
    const onLateResult = vi.fn(async () => {})
    const pending = tracker.run(
      'orca-session',
      'provider-session',
      async () => ({}),
      onLateResult,
      'compact:operation-1'
    )
    tracker.bindClaudeCommand('orca-session', 'compact:operation-1', 'compact-command', true)
    tracker.interrupted('orca-session')
    const handle = vi.fn()

    observeClaudeCompaction(
      tracker,
      {
        type: 'message',
        sessionId: 'orca-session',
        startsTurn: true,
        message: {
          type: 'user',
          session_id: 'provider-session',
          uuid: 'later-turn',
          message: { role: 'user', content: 'continue' }
        }
      },
      { handle }
    )

    await expect(pending).rejects.toThrow('interrupted')
    expect(tracker.hasPending('orca-session')).toBe(false)
    expect(handle).toHaveBeenCalledOnce()
    expect(onLateResult).toHaveBeenCalledWith({ error: 'Compaction was interrupted.' })
  })

  it('keeps a late replay of the interrupted compact command suppressed', async () => {
    const tracker = new StructuredSessionCompaction()
    const pending = tracker.run(
      'orca-session',
      'provider-session',
      async () => ({}),
      undefined,
      'compact:operation-1'
    )
    tracker.bindClaudeCommand('orca-session', 'compact:operation-1', 'compact-command', true)
    tracker.interrupted('orca-session')
    await expect(pending).rejects.toThrow('interrupted')
    const handle = vi.fn()

    observeClaudeCompaction(
      tracker,
      {
        type: 'message',
        sessionId: 'orca-session',
        startsTurn: true,
        message: {
          type: 'user',
          session_id: 'provider-session',
          uuid: 'compatibility-replay-id',
          message: { role: 'user', content: '/compact' }
        }
      },
      { handle }
    )

    expect(tracker.hasPending('orca-session')).toBe(true)
    expect(handle).not.toHaveBeenCalled()
    tracker.claude('orca-session', {
      type: 'command_lifecycle',
      state: 'cancelled',
      command_uuid: 'compact-command',
      session_id: 'provider-session'
    })
  })
})
