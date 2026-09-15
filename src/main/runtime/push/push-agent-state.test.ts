import { describe, expect, it } from 'vitest'
import { mapPushAgentState } from './push-dispatcher'

describe('mapPushAgentState', () => {
  it.each([
    ['blocked', 'needs-input'],
    ['waiting', 'needs-input'],
    ['done', 'finished'],
    [undefined, 'finished']
  ] as const)('maps agent-task-complete %s to %s', (agentState, expected) => {
    expect(mapPushAgentState('agent-task-complete', agentState)).toBe(expected)
  })

  it('suppresses a still-working agent', () => {
    expect(mapPushAgentState('agent-task-complete', 'working')).toBeUndefined()
  })

  it('leaves non-agent sources without a state', () => {
    expect(mapPushAgentState('terminal-bell', undefined)).toBeNull()
  })
})
