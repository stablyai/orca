import { describe, expect, it } from 'vitest'
import {
  parseAgentSessionOptionsRecord,
  parseClaudeSessionOptionsRecord
} from './session-context-reader'

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

  it('reads Codex Fast mode from applied thread settings', () => {
    expect(
      parseAgentSessionOptionsRecord(
        'codex',
        JSON.stringify({
          timestamp: '2026-08-08T20:20:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'thread_settings_applied',
            thread_settings: {
              model: 'gpt-5.6-sol',
              reasoning_effort: 'high',
              service_tier: 'priority'
            }
          }
        })
      )
    ).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'high',
      fastMode: true,
      recordedAt: Date.parse('2026-08-08T20:20:00.000Z')
    })
  })

  it('ignores non-Codex and unrelated records', () => {
    const line = JSON.stringify({ payload: { type: 'turn_context', model: 'gpt-5.6-sol' } })
    expect(parseAgentSessionOptionsRecord('claude', line)).toBeNull()
    expect(parseAgentSessionOptionsRecord('codex', '{}')).toBeNull()
  })
})

describe('parseClaudeSessionOptionsRecord', () => {
  it.each([
    ['ON', true],
    ['OFF', false]
  ])('reads Claude Fast mode %s confirmation', (label, fastMode) => {
    expect(
      parseClaudeSessionOptionsRecord(
        'claude',
        JSON.stringify({
          type: 'user',
          timestamp: '2026-08-08T21:55:23.382Z',
          message: {
            role: 'user',
            content: `<local-command-stdout>Fast mode ${label}</local-command-stdout>`
          }
        })
      )
    ).toEqual({ fastMode, recordedAt: Date.parse('2026-08-08T21:55:23.382Z') })
  })
})
