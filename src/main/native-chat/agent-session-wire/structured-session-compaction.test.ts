import { describe, expect, it, vi } from 'vitest'
import { StructuredSessionCompaction } from './structured-session-compaction'

const COMMAND = { turnId: 'compact:cmd-1', turnItemId: 'orca:command-turn:cmd-1' }

describe('structured compaction lifecycle', () => {
  it('waits beyond the Codex acknowledgment for the claimed turn and ignores other threads', async () => {
    const tracker = new StructuredSessionCompaction()
    const finished = vi.fn()
    const result = tracker
      .run('session', 'thread', async () => ({}), COMMAND)
      .then((value) => {
        finished()
        return value
      })
    await Promise.resolve()
    expect(tracker.claimTurn('session', 'other', 'foreign')).toBeNull()
    tracker.codex('session', 'turn/completed', {
      threadId: 'other',
      turn: { id: 'foreign', status: 'completed' }
    })
    expect(tracker.claimTurn('session', 'thread', 'compact-turn')).toBe(COMMAND.turnItemId)
    tracker.codex('session', 'item/completed', {
      threadId: 'thread',
      item: { type: 'contextCompaction' }
    })
    expect(finished).not.toHaveBeenCalled()
    tracker.codex('session', 'turn/completed', {
      threadId: 'thread',
      turn: { id: 'compact-turn', status: 'completed' }
    })
    await expect(result).resolves.toEqual({ outcome: 'success' })
  })

  it('claims one provider turn, the same one on a retry, and no other', async () => {
    const tracker = new StructuredSessionCompaction()
    void tracker.run('s', 't', async () => ({}), COMMAND)
    await Promise.resolve()
    expect(tracker.claimTurn('s', 't', 'c')).toBe(COMMAND.turnItemId)
    expect(tracker.claimTurn('s', 't', 'c')).toBe(COMMAND.turnItemId)
    expect(tracker.claimTurn('s', 't', 'later')).toBeNull()
    expect(tracker.providerTurnId('s', COMMAND.turnId)).toBe('c')
  })

  it('observes notifications arriving before the request acknowledgment', async () => {
    const tracker = new StructuredSessionCompaction()
    await expect(
      tracker.run(
        's',
        't',
        async () => {
          tracker.claimTurn('s', 't', 'c')
          tracker.codex('s', 'turn/completed', {
            threadId: 't',
            turn: { id: 'c', status: 'failed', error: { message: 'Unavailable' } }
          })
        },
        COMMAND
      )
    ).resolves.toEqual({ outcome: 'failure', error: 'Unavailable' })
  })

  it('reads an interrupted Codex turn as a cancellation', async () => {
    const tracker = new StructuredSessionCompaction()
    const result = tracker.run('s', 't', async () => ({}), COMMAND)
    await Promise.resolve()
    tracker.claimTurn('s', 't', 'c')
    tracker.codex('s', 'turn/completed', {
      threadId: 't',
      turn: { id: 'c', status: 'interrupted' }
    })
    await expect(result).resolves.toEqual({ outcome: 'cancellation' })
  })

  it.each(['success', 'failed'])(
    'uses Claude compact_result %s rather than result subtype',
    async (state) => {
      const tracker = new StructuredSessionCompaction()
      const result = tracker.run('s', 'provider', async () => {}, COMMAND)
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
        state === 'success'
          ? { outcome: 'success' }
          : { outcome: 'failure', error: 'Not enough messages to compact.' }
      )
    }
  )

  it('cleans up on provider exit and permits another operation', async () => {
    const tracker = new StructuredSessionCompaction()
    const pending = tracker.run('s', 'p', async () => {}, COMMAND)
    tracker.ended('s')
    await expect(pending).resolves.toEqual({
      outcome: 'failure',
      error: 'The provider exited during compaction.'
    })
    const next = tracker.run(
      's',
      'p',
      async () => {
        tracker.claude('s', { type: 'system', subtype: 'compact_boundary', session_id: 'p' })
        tracker.claude('s', { type: 'result', subtype: 'success', session_id: 'p' })
      },
      COMMAND
    )
    await expect(next).resolves.toEqual({ outcome: 'success' })
  })

  it('ends a command at Stop before the provider opened a turn for it', async () => {
    const tracker = new StructuredSessionCompaction()
    const result = tracker.run('s', 't', async () => ({}), COMMAND)
    await Promise.resolve()
    tracker.abandon('s')
    await expect(result).resolves.toEqual({ outcome: 'cancellation' })
    // The provider turn that opens afterwards is still the command's, so the interrupt finds it.
    expect(tracker.claimTurn('s', 't', 'c')).toBe(COMMAND.turnItemId)
    expect(tracker.providerTurnId('s', COMMAND.turnId)).toBe('c')
    tracker.codex('s', 'turn/completed', {
      threadId: 't',
      turn: { id: 'c', status: 'interrupted' }
    })
    expect(tracker.hasPending('s')).toBe(false)
  })

  it('keeps the cancellation when the provider reports an error after Stop', async () => {
    const tracker = new StructuredSessionCompaction()
    const result = tracker.run('s', 'p', async () => {}, COMMAND)
    tracker.abandon('s')
    tracker.claude('s', { type: 'result', subtype: 'error_during_execution', session_id: 'p' })
    await expect(result).resolves.toEqual({ outcome: 'cancellation' })
    expect(tracker.hasPending('s')).toBe(false)
  })

  it('does not mistake an unrelated completed turn for compaction', async () => {
    const tracker = new StructuredSessionCompaction()
    const result = tracker.run('s', 't', async () => ({}), COMMAND)
    await Promise.resolve()
    tracker.claimTurn('s', 't', 'c')
    tracker.codex('s', 'turn/completed', { threadId: 't', turn: { id: 'c', status: 'completed' } })
    await expect(result).resolves.toEqual({
      outcome: 'failure',
      error: 'Compaction did not complete.'
    })
  })

  it('releases the entry when the send itself throws', async () => {
    const tracker = new StructuredSessionCompaction()
    await expect(
      tracker.run(
        's',
        'p',
        async () => {
          throw new Error('pipe closed')
        },
        COMMAND
      )
    ).rejects.toThrow('pipe closed')
    expect(tracker.hasPending('s')).toBe(false)
  })
})
