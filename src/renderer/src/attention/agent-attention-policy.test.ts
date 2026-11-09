import { describe, expect, it, vi } from 'vitest'
import type { AgentAttentionSurface } from './agent-attention-contract'
import {
  applyAgentAttention,
  resolveAgentAttention,
  type AgentAttentionRequest,
  type AgentAttentionSink
} from './agent-attention-policy'

const WORKSPACE = 'wt-1'
const SUBJECT = 'tab-1:leaf-1'
const GROUP = 'tab-1'

function makeSurface(overrides: Partial<AgentAttentionSurface> = {}): AgentAttentionSurface {
  return {
    hasLiveSession: () => true,
    admitSurface: () => ({ admitted: true, groupId: GROUP }),
    isSurfaceViewed: () => false,
    isWorkspaceViewed: () => false,
    isWorkspaceActive: () => false,
    isWorkspaceMuted: () => false,
    resolveViewedSubjectKey: () => null,
    ...overrides
  }
}

function completion(overrides: Partial<AgentAttentionRequest> = {}): AgentAttentionRequest {
  return {
    subject: { workspaceId: WORKSPACE, surfaceKey: SUBJECT },
    reason: 'agent-completion',
    settlesTurn: true,
    hasFreshActivityEvidence: false,
    ...overrides
  }
}

function makeSink(): AgentAttentionSink & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    unread: (write) =>
      calls.push(
        `unread:${write.workspaceId}:${write.subjectKey}:${write.groupId}:${write.reason}`
      ),
    requestDelivery: (request) => calls.push(`deliver:${request.workspaceId}:${request.subjectKey}`)
  }
}

describe('resolveAgentAttention', () => {
  it('rejects a muted workspace before any other gate, so it earns no unread or delivery', () => {
    const hasLiveSession = vi.fn(() => true)
    const decision = resolveAgentAttention(
      completion(),
      makeSurface({ isWorkspaceMuted: () => true, hasLiveSession })
    )
    expect(decision).toEqual({ admitted: false, cause: 'muted-workspace' })
    expect(hasLiveSession).not.toHaveBeenCalled()
    const sink = makeSink()
    applyAgentAttention(decision, sink)
    expect(sink.calls).toEqual([])
  })

  it('admits a viewed surface for delivery but earns it no unread', () => {
    const decision = resolveAgentAttention(
      completion(),
      makeSurface({ isSurfaceViewed: () => true })
    )
    expect(decision).toMatchObject({ admitted: true, unread: null })

    const sink = makeSink()
    applyAgentAttention(decision, sink)
    expect(sink.calls).toEqual([`deliver:${WORKSPACE}:${SUBJECT}`])
  })

  it('hands the unread write, with its admitted group and reason, to the sink', () => {
    const sink = makeSink()
    applyAgentAttention(resolveAgentAttention(completion(), makeSurface()), sink)
    expect(sink.calls).toEqual([
      `unread:${WORKSPACE}:${SUBJECT}:${GROUP}:agent-completion`,
      `deliver:${WORKSPACE}:${SUBJECT}`
    ])
  })

  it('delivers a bell without validating the surface address or writing unread', () => {
    const admitSurface = vi.fn()
    const isSurfaceViewed = vi.fn()
    const decision = resolveAgentAttention(
      completion({ reason: 'terminal-bell', settlesTurn: false }),
      makeSurface({ admitSurface, isSurfaceViewed })
    )
    expect(decision).toMatchObject({ admitted: true, unread: null })
    expect(admitSurface).not.toHaveBeenCalled()
    expect(isSurfaceViewed).not.toHaveBeenCalled()

    const sink = makeSink()
    applyAgentAttention(decision, sink)
    expect(sink.calls).toEqual([`deliver:${WORKSPACE}:${SUBJECT}`])
  })
})
