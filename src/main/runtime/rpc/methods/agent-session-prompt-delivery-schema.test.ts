import { describe, expect, it } from 'vitest'
import { CreateAgentSessionParams, EnsureAgentSessionParams } from './agent-session'

const providerSession = { key: 'session_id' as const, id: 'session-1' }

describe('agent session prompt delivery schema', () => {
  it('keeps client-owned delivery content out of structured host requests', () => {
    expect(
      CreateAgentSessionParams.safeParse({
        clientOperationId: `${Date.now()}-${'ab'.repeat(16)}`,
        worktree: 'id:worktree-1',
        agent: 'opencode',
        promptDelivery: 'draft',
        promptDeliveryOwner: 'client'
      }).success
    ).toBe(true)
    expect(
      CreateAgentSessionParams.safeParse({
        clientOperationId: `${Date.now()}-${'ab'.repeat(16)}`,
        worktree: 'id:worktree-1',
        agent: 'opencode',
        prompt: 'duplicate me',
        promptDelivery: 'draft',
        promptDeliveryOwner: 'client'
      }).success
    ).toBe(false)
  })

  it('accepts a host-owned resume draft and a contentless client-owned resume', () => {
    expect(
      EnsureAgentSessionParams.safeParse({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerSession,
        prompt: 'continue here',
        promptDelivery: 'draft'
      }).success
    ).toBe(true)
    expect(
      EnsureAgentSessionParams.safeParse({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerSession,
        promptDelivery: 'draft',
        promptDeliveryOwner: 'client'
      }).success
    ).toBe(true)
  })
})
