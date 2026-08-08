import { describe, expect, it } from 'vitest'
import { parseAgentSessionOptionsRecord } from './session-context-reader'

describe('parseAgentSessionOptionsRecord', () => {
  it('reads the exact Codex model and effort from turn_context', () => {
    expect(
      parseAgentSessionOptionsRecord(
        'codex',
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'turn_context', model: 'gpt-5.6-sol', effort: 'xhigh' }
        })
      )
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh', recordedAt: null })
  })

  it('reads the record-level turn_context shape current Codex rollouts write', () => {
    expect(
      parseAgentSessionOptionsRecord(
        'codex',
        JSON.stringify({
          type: 'turn_context',
          timestamp: '2026-08-07T16:09:10.106Z',
          payload: { turn_id: 't-1', model: 'gpt-5.6-luna', effort: 'medium', summary: 'auto' }
        })
      )
    ).toEqual({
      model: 'gpt-5.6-luna',
      effort: 'medium',
      recordedAt: Date.parse('2026-08-07T16:09:10.106Z')
    })
  })

  it('ignores non-Codex and unrelated records', () => {
    const line = JSON.stringify({ payload: { type: 'turn_context', model: 'gpt-5.6-sol' } })
    expect(parseAgentSessionOptionsRecord('claude', line)).toBeNull()
    expect(parseAgentSessionOptionsRecord('codex', '{}')).toBeNull()
  })
})
