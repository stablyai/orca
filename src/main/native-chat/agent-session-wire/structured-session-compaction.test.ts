import { describe, expect, it, vi } from 'vitest'
import { StructuredSessionCompaction } from './structured-session-compaction'

describe('structured compaction lifecycle', () => {
  it('waits beyond the Codex acknowledgment and ignores other threads', async () => {
    const tracker = new StructuredSessionCompaction()
    const finished = vi.fn()
    const result = tracker
      .run('session', 'thread', async () => ({}))
      .then((value) => {
        finished()
        return value
      })
    await Promise.resolve()
    tracker.codex('session', 'turn/started', { threadId: 'other', turn: { id: 'foreign' } })
    tracker.codex('session', 'turn/completed', {
      threadId: 'other',
      turn: { id: 'foreign', status: 'completed' }
    })
    expect(finished).not.toHaveBeenCalled()
    tracker.codex('session', 'turn/started', { threadId: 'thread', turn: { id: 'compact-turn' } })
    tracker.codex('session', 'item/completed', {
      threadId: 'thread',
      item: { type: 'contextCompaction' }
    })
    expect(finished).not.toHaveBeenCalled()
    tracker.codex('session', 'turn/completed', {
      threadId: 'thread',
      turn: { id: 'compact-turn', status: 'completed' }
    })
    await expect(result).resolves.toEqual({})
  })

  it('observes notifications arriving before the request acknowledgment', async () => {
    const tracker = new StructuredSessionCompaction()
    await expect(
      tracker.run('s', 't', async () => {
        tracker.codex('s', 'turn/started', { threadId: 't', turn: { id: 'c' } })
        tracker.codex('s', 'turn/completed', {
          threadId: 't',
          turn: { id: 'c', status: 'failed', error: { message: 'Unavailable' } }
        })
      })
    ).resolves.toEqual({ error: 'Unavailable' })
  })

  it.each(['success', 'failed'])(
    'uses Claude compact_result %s rather than result subtype',
    async (state) => {
      const tracker = new StructuredSessionCompaction()
      const result = tracker.run('s', 'provider', async () => {})
      tracker.claude('s', {
        type: 'system',
        subtype: 'status',
        session_id: 'provider',
        compact_result: state,
        compact_error: 'Not enough messages to compact.'
      })
      tracker.claude('s', {
        type: 'result',
        subtype: 'success',
        session_id: 'provider',
        result: ''
      })
      await expect(result).resolves.toEqual(
        state === 'success' ? {} : { error: 'Not enough messages to compact.' }
      )
    }
  )

  it('cleans up on provider exit and permits another operation', async () => {
    const tracker = new StructuredSessionCompaction()
    const pending = tracker.run('s', 'p', async () => {})
    tracker.ended('s')
    await expect(pending).resolves.toEqual({ error: 'The provider exited during compaction.' })
    const next = tracker.run('s', 'p', async () => {
      tracker.claude('s', { type: 'system', subtype: 'compact_boundary', session_id: 'p' })
      tracker.claude('s', { type: 'result', subtype: 'success', session_id: 'p' })
    })
    await expect(next).resolves.toEqual({})
  })
  it('reconciles a terminal frame after timeout without repeating the provider request', async () => {
    vi.useFakeTimers()
    try {
      const tracker = new StructuredSessionCompaction(10)
      const late = vi.fn(async () => {})
      const invoke = vi.fn(async () => ({}))
      const result = tracker.run('s', 'p', invoke, late)
      const rejected = expect(result).rejects.toThrow('unconfirmed')
      await vi.advanceTimersByTimeAsync(11)
      await rejected
      tracker.claude('s', { type: 'system', subtype: 'compact_boundary', session_id: 'p' })
      tracker.claude('s', { type: 'result', subtype: 'success', session_id: 'p' })
      expect(late).toHaveBeenCalledWith({})
      expect(invoke).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not mistake an unrelated completed turn for compaction', async () => {
    const tracker = new StructuredSessionCompaction()
    const result = tracker.run('s', 't', async () => ({}))
    tracker.codex('s', 'turn/started', { threadId: 't', turn: { id: 'c' } })
    tracker.codex('s', 'turn/completed', { threadId: 't', turn: { id: 'c', status: 'completed' } })
    await expect(result).resolves.toEqual({ error: 'Compaction did not complete.' })
  })
})
