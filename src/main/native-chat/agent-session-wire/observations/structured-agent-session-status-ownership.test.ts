import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import {
  StructuredAgentSessionStatusOwnership,
  type StructuredAgentSessionStatusSink
} from './structured-agent-session-status-ownership'

const FIRST = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: '/w1',
  workspaceKind: 'folder'
} as const
const MOVED = { ...FIRST, workspaceId: '/w2' } as const

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; publish reads only sessionId here
const summary = { sessionId: 'session-1' } as AgentSessionStatusSummary

function setup(publish: StructuredAgentSessionStatusSink['publish']) {
  const forget = vi.fn()
  const onSubjectForgotten = vi.fn()
  const sink: StructuredAgentSessionStatusSink = { publish, forget }
  const ownership = new StructuredAgentSessionStatusOwnership(() => ({
    statusSink: () => sink,
    onSubjectForgotten
  }))
  return { ownership, forget, onSubjectForgotten }
}

describe('structured status relocation', () => {
  it('tells readers the old subject is gone after a relocation', () => {
    const { ownership, forget, onSubjectForgotten } = setup(() => {})
    ownership.publish(summary, FIRST)
    expect(onSubjectForgotten).not.toHaveBeenCalled()
    ownership.publish(summary, MOVED)
    expect(forget).toHaveBeenCalledTimes(1)
    expect(onSubjectForgotten).toHaveBeenCalledWith('session-1')
  })

  it('still tells readers when publishing the relocated subject throws, and leaves it not landed', () => {
    let fail = false
    const { ownership, forget, onSubjectForgotten } = setup(() => {
      if (fail) {
        throw new Error('publish failed')
      }
    })
    ownership.publish(summary, FIRST)
    fail = true
    expect(() => ownership.publish(summary, MOVED)).toThrow('publish failed')
    expect(forget).toHaveBeenCalledTimes(1)
    expect(onSubjectForgotten).toHaveBeenCalledWith('session-1')
    expect(ownership.matchesLocation('session-1', MOVED)).toBe(false)
  })
})
