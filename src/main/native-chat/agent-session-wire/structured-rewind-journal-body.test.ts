import { describe, expect, it } from 'vitest'
import { AgentSessionRewindRecordSchema } from '../../../shared/agent-session-rewind'
import { restoreRewindJournalBody } from './structured-rewind-journal-body'

/** A row this build cannot place: still a row, never its stored JSON. */
const UNPLACEABLE = {
  kind: 'status',
  text: 'Orca could not show this item after the rewind.',
  failure: { kind: 'hostFault' }
}

describe('rewind recovery of newer durable records', () => {
  it('keeps an unknown message role and block readable without discarding the row', () => {
    expect(
      restoreRewindJournalBody({
        kind: 'message',
        role: 'future-role',
        blocks: [{ type: 'future-block' }]
      })
    ).toEqual({
      kind: 'message',
      role: 'system',
      blocks: [{ type: 'text', text: '{"type":"future-block"}' }]
    })
  })

  it('preserves background-task blocks across rewind recovery', () => {
    const body = {
      kind: 'message' as const,
      role: 'system',
      blocks: [
        { type: 'text' as const, text: 'Started background command "sleep 20"' },
        {
          type: 'background-task' as const,
          taskId: 'task-1',
          kind: 'command',
          label: 'sleep 20',
          state: 'working'
        }
      ]
    }

    expect(restoreRewindJournalBody(body)).toEqual(body)
  })

  it('preserves unknown state as evidence rather than inventing success or pending work', () => {
    const body = {
      kind: 'tool-call' as const,
      name: 'future-tool',
      input: { path: 'file' },
      state: 'paused-by-provider'
    }
    expect(restoreRewindJournalBody(body)).toEqual(UNPLACEABLE)
    const status = {
      kind: 'status' as const,
      text: 'state',
      turnLifecycle: { turnId: 'turn', state: 'future-state' }
    }
    expect(restoreRewindJournalBody(status)).toEqual(UNPLACEABLE)
  })
  it.each(['interrupted', 'unverifiable'] as const)(
    'keeps a %s turn and its recorded endpoints',
    (state) => {
      const status = {
        kind: 'status' as const,
        text: 'Working',
        turnLifecycle: {
          turnId: 'turn',
          state,
          startedAt: 10,
          ...(state === 'interrupted' ? { completedAt: 20 } : {})
        }
      }
      expect(restoreRewindJournalBody(status)).toEqual(status)
    }
  )
  it('accepts a canonical turn body with a known state and keeps an unknown one as evidence', () => {
    const turn = {
      kind: 'turn' as const,
      turnId: 'turn',
      state: 'completed',
      userItemId: 'codex:thread:turn:0',
      startedAt: 10,
      completedAt: 20,
      durationMs: 10
    }
    expect(restoreRewindJournalBody(turn)).toEqual(turn)
    const unknown = { ...turn, state: 'future-state' }
    expect(restoreRewindJournalBody(unknown)).toEqual(UNPLACEABLE)
  })
  it('keeps a known turn outcome across rewind recovery in both journal shapes', () => {
    const turn = {
      kind: 'turn' as const,
      turnId: 'turn',
      state: 'completed',
      outcome: 'failure',
      userItemId: 'codex:thread:turn:0',
      startedAt: 10,
      completedAt: 20
    }
    expect(restoreRewindJournalBody(turn)).toEqual(turn)
    const status = {
      kind: 'status' as const,
      text: 'Claude turn completed',
      turnLifecycle: { turnId: 'turn', state: 'interrupted', outcome: 'cancellation' }
    }
    expect(restoreRewindJournalBody(status)).toEqual(status)
  })

  it('drops a turn outcome from a later vocabulary but keeps the turn and its endpoints', () => {
    // An unknown outcome costs nothing to discard, because absent already means
    // unknown. Falling back to a status row the way an unknown STATE does would
    // take the turn's endpoints with it, and every timing surface reads those.
    expect(
      restoreRewindJournalBody({
        kind: 'turn',
        turnId: 'turn',
        state: 'completed',
        outcome: 'partially-refused',
        userItemId: 'codex:thread:turn:0',
        startedAt: 10,
        completedAt: 20
      })
    ).toEqual({
      kind: 'turn',
      turnId: 'turn',
      state: 'completed',
      userItemId: 'codex:thread:turn:0',
      startedAt: 10,
      completedAt: 20
    })
    expect(
      restoreRewindJournalBody({
        kind: 'status',
        text: 'Codex turn completed',
        turnLifecycle: { turnId: 'turn', state: 'completed', outcome: 'partially-refused' }
      })
    ).toEqual({
      kind: 'status',
      text: 'Codex turn completed',
      turnLifecycle: { turnId: 'turn', state: 'completed' }
    })
  })

  it('does not reject a saved recovery prefix over a newer refusal reason', () => {
    expect(
      AgentSessionRewindRecordSchema.safeParse({
        operationId: 'operation',
        callerKey: 'caller',
        itemId: 'selected',
        expectedEpoch: 'old',
        phase: 'provider-succeeded',
        reason: 'future-reason',
        retained: []
      }).success
    ).toBe(true)
  })
})
