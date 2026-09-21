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
