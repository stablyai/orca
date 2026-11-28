import { describe, expect, it } from 'vitest'
import type { AgentAttentionSurface } from './agent-attention-contract'
import { resolveAgentAttention } from './agent-attention-policy'

function surface(viewed: boolean): AgentAttentionSurface {
  return {
    hasLiveSession: () => true,
    admitSurface: () => ({ admitted: true, groupId: 'tab' }),
    isSurfaceViewed: () => viewed,
    isWorkspaceViewed: () => viewed,
    isWorkspaceActive: () => true,
    isWorkspaceMuted: () => false,
    resolveViewedSubjectKey: () => null
  }
}

const completion = {
  subject: { workspaceId: 'ws-1', surfaceKey: 'pane-1' },
  reason: 'agent-completion' as const,
  settlesTurn: false,
  hasFreshActivityEvidence: false
}

describe('suppress while focused', () => {
  it('does not treat a selected worktree covered by another view as already visible', () => {
    const decision = resolveAgentAttention(completion, surface(false))
    expect(decision.admitted).toBe(true)
    if (!decision.admitted) {
      return
    }
    expect(decision.delivery.workspaceIsActive).toBe(false)
  })

  it('still treats the worktree as visible when that workspace is on screen', () => {
    const decision = resolveAgentAttention(completion, surface(true))
    expect(decision.admitted).toBe(true)
    if (!decision.admitted) {
      return
    }
    expect(decision.delivery.workspaceIsActive).toBe(true)
  })
})
