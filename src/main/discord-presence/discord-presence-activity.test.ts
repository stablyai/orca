import { describe, it, expect } from 'vitest'
import { aggregateAgentStatus, buildDiscordActivity } from './discord-presence-activity'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { DiscordPresenceSnapshot } from './discord-presence-activity'

// Helper: build a minimal IPC payload with only the fields aggregateAgentStatus reads.
function entry(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    state: 'working',
    paneKey: `pane-${Math.random().toString(36).slice(2)}`,
    connectionId: null,
    receivedAt: 1000,
    stateStartedAt: 1000,
    prompt: '',
    ...overrides
  }
}

describe('aggregateAgentStatus', () => {
  it('returns zero snapshot for empty input', () => {
    const snap = aggregateAgentStatus([])
    expect(snap).toEqual({
      working: 0,
      blocked: 0,
      waiting: 0,
      done: 0,
      active: 0,
      total: 0,
      agentTypes: [],
      startedAt: 0
    })
  })

  it('counts one working agent correctly', () => {
    const snap = aggregateAgentStatus([entry({ state: 'working', agentType: 'claude', receivedAt: 1000 })])
    expect(snap.working).toBe(1)
    expect(snap.active).toBe(1)
    expect(snap.total).toBe(1)
    expect(snap.agentTypes).toEqual(['claude'])
    expect(snap.startedAt).toBe(1000)
  })

  it('aggregates mixed states without double counting', () => {
    const snap = aggregateAgentStatus([
      entry({ state: 'working', agentType: 'claude', receivedAt: 1000 }),
      entry({ state: 'working', agentType: 'codex', receivedAt: 2000 }),
      entry({ state: 'blocked', agentType: 'gemini', receivedAt: 1500 }),
      entry({ state: 'waiting', agentType: 'opencode', receivedAt: 1200 }),
      entry({ state: 'done', agentType: 'devin', receivedAt: 900 })
    ])
    expect(snap.working).toBe(2)
    expect(snap.blocked).toBe(1)
    expect(snap.waiting).toBe(1)
    expect(snap.done).toBe(1)
    expect(snap.active).toBe(4)
    expect(snap.total).toBe(5)
    // done excluded from agentTypes, remaining sorted
    expect(snap.agentTypes).toEqual(['claude', 'codex', 'gemini', 'opencode'])
    // earliest active receivedAt
    expect(snap.startedAt).toBe(1000)
  })

  it('picks currentTool from a working entry', () => {
    const snap = aggregateAgentStatus([
      entry({ state: 'working', agentType: 'claude', toolName: 'Edit', receivedAt: 1000 })
    ])
    expect(snap.currentTool).toBe('Edit')
  })

  it('ignores providerSessionOnly entries', () => {
    const snap = aggregateAgentStatus([
      entry({ state: 'working', agentType: 'claude', providerSessionOnly: true, receivedAt: 1000 })
    ])
    expect(snap.active).toBe(0)
    expect(snap.total).toBe(0)
  })

  it('ignores entries without paneKey', () => {
    const snap = aggregateAgentStatus([
      entry({ state: 'working', agentType: 'claude', paneKey: '', receivedAt: 1000 })
    ])
    expect(snap.active).toBe(0)
    expect(snap.total).toBe(0)
  })

  it('returns zero for done-only list', () => {
    const snap = aggregateAgentStatus([
      entry({ state: 'done', agentType: 'claude', receivedAt: 1000 }),
      entry({ state: 'done', agentType: 'codex', receivedAt: 2000 })
    ])
    expect(snap.active).toBe(0)
    expect(snap.total).toBe(2)
    expect(snap.agentTypes).toEqual([])
    expect(snap.startedAt).toBe(0)
  })

  it('deduplicates and sorts agentTypes', () => {
    const snap = aggregateAgentStatus([
      entry({ state: 'working', agentType: 'codex', receivedAt: 1000 }),
      entry({ state: 'working', agentType: 'claude', receivedAt: 1000 }),
      entry({ state: 'blocked', agentType: 'codex', receivedAt: 1000 })
    ])
    expect(snap.agentTypes).toEqual(['claude', 'codex'])
  })
})

// ─── buildDiscordActivity ────────────────────────────────────────────

function snap(overrides: Partial<DiscordPresenceSnapshot> = {}): DiscordPresenceSnapshot {
  return {
    working: 0,
    blocked: 0,
    waiting: 0,
    done: 0,
    active: 0,
    total: 0,
    agentTypes: [],
    startedAt: 0,
    ...overrides
  }
}

describe('buildDiscordActivity', () => {
  const ASSET = 'orca'

  it('returns null when no active agents', () => {
    expect(buildDiscordActivity(snap(), ASSET)).toBeNull()
  })

  it('returns null when only done agents', () => {
    expect(buildDiscordActivity(snap({ done: 3, total: 3 }), ASSET)).toBeNull()
  })

  it('builds activity for single working agent', () => {
    const activity = buildDiscordActivity(
      snap({ working: 1, active: 1, total: 1, agentTypes: ['claude'], startedAt: 1000 }),
      ASSET
    )
    expect(activity).toEqual({
      details: '1 agent working',
      state: 'Claude',
      assets: { large_image: 'orca', large_text: 'Orca' },
      timestamps: { start: 1000 }
    })
  })

  it('builds activity for multiple working agents', () => {
    const activity = buildDiscordActivity(
      snap({ working: 3, active: 3, total: 3, agentTypes: ['claude', 'codex', 'gemini'], startedAt: 2000 }),
      ASSET
    )
    expect(activity?.details).toBe('3 agents working')
    expect(activity?.state).toBe('Claude · Codex · Gemini')
  })

  it('truncates agent list when more than 3 types', () => {
    const activity = buildDiscordActivity(
      snap({
        working: 4,
        active: 4,
        total: 4,
        agentTypes: ['claude', 'codex', 'gemini', 'opencode']
      }),
      ASSET
    )
    expect(activity?.state).toBe('Claude · Codex · Gemini · …')
  })

  it('shows blocked signal in state', () => {
    const activity = buildDiscordActivity(
      snap({
        working: 2,
        blocked: 1,
        active: 3,
        total: 3,
        agentTypes: ['claude', 'codex']
      }),
      ASSET
    )
    expect(activity?.state).toBe('Claude · Codex · 1 waiting for you')
  })

  it('omits timestamps when startedAt is 0', () => {
    const activity = buildDiscordActivity(
      snap({ working: 1, active: 1, total: 1, agentTypes: ['claude'] }),
      ASSET
    )
    expect(activity?.timestamps).toBeUndefined()
  })
})