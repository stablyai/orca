import { describe, expect, it } from 'vitest'
import { AgentSessionRewindRecordSchema } from '../../../shared/agent-session-rewind'
import { restoreRewindJournalBody } from './structured-rewind-journal-body'

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
  it('preserves unknown state as evidence rather than inventing success or pending work', () => {
    const body = {
      kind: 'tool-call' as const,
      name: 'future-tool',
      input: { path: 'file' },
      state: 'paused-by-provider'
    }
    expect(restoreRewindJournalBody(body)).toEqual({ kind: 'status', text: JSON.stringify(body) })
    const status = {
      kind: 'status' as const,
      text: 'state',
      turnLifecycle: { turnId: 'turn', state: 'future-state' }
    }
    expect(restoreRewindJournalBody(status)).toEqual({
      kind: 'status',
      text: JSON.stringify(status)
    })
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
    expect(restoreRewindJournalBody(unknown)).toEqual({
      kind: 'status',
      text: JSON.stringify(unknown)
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
