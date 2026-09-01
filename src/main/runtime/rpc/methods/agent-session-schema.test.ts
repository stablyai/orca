import { describe, expect, it } from 'vitest'
import { CreateAgentSessionParams, EnsureAgentSessionParams } from './agent-session'

const CUSTOM_ID = 'custom-agent:codex:11111111-1111-4111-8111-111111111111'

function createParams(agent: string): unknown {
  return {
    clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
    worktree: 'id:wt-1',
    agent
  }
}

describe('CreateAgentSessionParams agent identity', () => {
  it('accepts a built-in agent id', () => {
    expect(CreateAgentSessionParams.safeParse(createParams('codex')).success).toBe(true)
  })

  it('accepts a well-formed custom agent id (catalog membership is host-resolved)', () => {
    expect(CreateAgentSessionParams.safeParse(createParams(CUSTOM_ID)).success).toBe(true)
  })

  it('rejects unknown and malformed agent ids', () => {
    expect(CreateAgentSessionParams.safeParse(createParams('not-an-agent')).success).toBe(false)
    expect(
      CreateAgentSessionParams.safeParse(
        // The custom-id grammar requires a built-in base segment.
        createParams('custom-agent:not-a-base:11111111-1111-4111-8111-111111111111')
      ).success
    ).toBe(false)
  })
})

describe('EnsureAgentSessionParams explicit resume identity', () => {
  it('keeps accepting built-in resumable ids (old-client wire compat)', () => {
    const result = EnsureAgentSessionParams.safeParse({
      kind: 'explicit',
      worktree: 'id:wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'abc123' }
    })
    expect(result.success).toBe(true)
  })

  it('stays built-in-only: a custom session resumes via its launch snapshot, not a rebuilt command', () => {
    const result = EnsureAgentSessionParams.safeParse({
      kind: 'explicit',
      worktree: 'id:wt-1',
      agent: CUSTOM_ID,
      providerSession: { key: 'session_id', id: 'abc123' }
    })
    expect(result.success).toBe(false)
  })
})
