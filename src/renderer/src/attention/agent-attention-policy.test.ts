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
    resolveViewedSubjectKey: () => null,
    collectWorkspaceAttentionRemainder: () => ({
      hasSurfaces: true,
      unreadSubjectKeys: [],
      unreadGroupIds: []
    }),
    ...overrides
  }
}

function completion(overrides: Partial<AgentAttentionRequest> = {}): AgentAttentionRequest {
  return {
    subject: { workspaceId: WORKSPACE, surfaceKey: SUBJECT },
    reason: 'agent-completion',
    settlesTurn: true,
    hasFreshActivityEvidence: false,
    groupAttentionEnabled: false,
    ...overrides
  }
}

function makeSink(): AgentAttentionSink & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    unread: {
      markWorkspaceUnread: (workspaceId) => calls.push(`workspace:${workspaceId}`),
      markSubjectUnread: (key, reason) => calls.push(`subject:${key}:${reason}`),
      markGroupUnread: (key, reason) => calls.push(`group:${key}:${reason}`),
      markSurfaceUnread: (key, reason) => calls.push(`surface:${key}:${reason}`)
    },
    requestDelivery: (request) => calls.push(`deliver:${request.workspaceId}:${request.subjectKey}`)
  }
}

describe('resolveAgentAttention', () => {
  it('rejects a subject with no live session and no fresh activity evidence', () => {
    const decision = resolveAgentAttention(
      completion(),
      makeSurface({ hasLiveSession: () => false })
    )
    expect(decision).toEqual({ admitted: false, cause: 'no-live-session' })
  })

  it('admits a dead surface when fresh activity evidence stands in for liveness', () => {
    const admitSurface = vi.fn(() => ({ admitted: true, groupId: GROUP }) as const)
    const decision = resolveAgentAttention(
      completion({ hasFreshActivityEvidence: true }),
      makeSurface({ hasLiveSession: () => false, admitSurface })
    )
    expect(decision.admitted).toBe(true)
    // The surface must be told which evidence admitted the event so it can pick its gate.
    expect(admitSurface).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE, surfaceKey: SUBJECT },
      { hasLiveSession: false, hasFreshActivityEvidence: true }
    )
  })

  it('rejects a superseded surface outright — no unread and no delivery', () => {
    const decision = resolveAgentAttention(
      completion(),
      makeSurface({ admitSurface: () => ({ admitted: false, cause: 'superseded-surface' }) })
    )
    expect(decision).toEqual({ admitted: false, cause: 'superseded-surface' })

    const sink = makeSink()
    applyAgentAttention(decision, sink)
    expect(sink.calls).toEqual([])
  })

  it('rejects a surface key that resolves to no container', () => {
    const decision = resolveAgentAttention(
      completion(),
      makeSurface({ admitSurface: () => ({ admitted: false, cause: 'unknown-surface' }) })
    )
    expect(decision).toEqual({ admitted: false, cause: 'unknown-surface' })
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

  it('carries the unread reason into every store write', () => {
    const decision = resolveAgentAttention(
      completion({ groupAttentionEnabled: true }),
      makeSurface()
    )
    const sink = makeSink()
    applyAgentAttention(decision, sink)
    expect(sink.calls).toEqual([
      `workspace:${WORKSPACE}`,
      `subject:${SUBJECT}:agent-completion`,
      `group:${GROUP}:agent-completion`,
      `surface:${SUBJECT}:agent-completion`,
      `deliver:${WORKSPACE}:${SUBJECT}`
    ])
  })

  it('keeps container attention behind its presentation flag', () => {
    const sink = makeSink()
    applyAgentAttention(resolveAgentAttention(completion(), makeSurface()), sink)
    expect(sink.calls).toEqual([
      `workspace:${WORKSPACE}`,
      `subject:${SUBJECT}:agent-completion`,
      `deliver:${WORKSPACE}:${SUBJECT}`
    ])
  })

  it('falls back to workspace visibility when the event names no surface', () => {
    const isWorkspaceViewed = vi.fn(() => true)
    const admitSurface = vi.fn()
    const decision = resolveAgentAttention(
      completion({ subject: { workspaceId: WORKSPACE } }),
      makeSurface({ isWorkspaceViewed, admitSurface })
    )
    expect(decision).toMatchObject({ admitted: true, unread: null })
    expect(isWorkspaceViewed).toHaveBeenCalledWith(WORKSPACE)
    // No surface key means there is no address to validate.
    expect(admitSurface).not.toHaveBeenCalled()
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

  it('reports in-app workspace selection to the delivery owner', () => {
    const decision = resolveAgentAttention(
      completion(),
      makeSurface({ isWorkspaceActive: (workspaceId) => workspaceId === WORKSPACE })
    )
    expect(decision).toMatchObject({ admitted: true, delivery: { workspaceIsActive: true } })
  })

  it('writes unread before requesting delivery so a suppressed banner still leaves a marker', () => {
    const sink = makeSink()
    applyAgentAttention(resolveAgentAttention(completion(), makeSurface()), sink)
    expect(sink.calls.indexOf(`workspace:${WORKSPACE}`)).toBeLessThan(
      sink.calls.indexOf(`deliver:${WORKSPACE}:${SUBJECT}`)
    )
  })
})
