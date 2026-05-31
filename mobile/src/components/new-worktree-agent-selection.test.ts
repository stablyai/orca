import { describe, expect, it } from 'vitest'

import {
  NEW_WORKTREE_BLANK_AGENT,
  newWorktreeAgentOptionFor,
  pickPreferredNewWorktreeAgent,
  resolveNewWorktreeAgentSelection
} from './new-worktree-agent-selection'

describe('new worktree agent selection', () => {
  it('picks the preferred detected agent when there is no user override', () => {
    const selected = newWorktreeAgentOptionFor('claude')
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: selected,
      agentOverridden: false,
      runtimeSettings: { defaultTuiAgent: 'codex' },
      detectedAgentIds: new Set(['claude', 'codex'])
    })

    expect(resolved).toEqual({
      selectedAgent: newWorktreeAgentOptionFor('codex'),
      agentOverridden: false
    })
  })

  it('keeps an available user override', () => {
    const selected = newWorktreeAgentOptionFor('codex')
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: selected,
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'claude' },
      detectedAgentIds: new Set(['claude', 'codex'])
    })

    expect(resolved).toEqual({ selectedAgent: selected, agentOverridden: true })
  })

  it('clears an unavailable user override after detection completes', () => {
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: newWorktreeAgentOptionFor('codex'),
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'claude' },
      detectedAgentIds: new Set(['claude'])
    })

    expect(resolved).toEqual({
      selectedAgent: newWorktreeAgentOptionFor('claude'),
      agentOverridden: false
    })
  })

  it('clears a disabled user override after detection completes', () => {
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: newWorktreeAgentOptionFor('codex'),
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'claude', disabledTuiAgents: ['codex'] },
      detectedAgentIds: new Set(['claude', 'codex'])
    })

    expect(resolved).toEqual({
      selectedAgent: newWorktreeAgentOptionFor('claude'),
      agentOverridden: false
    })
  })

  it('keeps blank terminal as an explicit override', () => {
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: NEW_WORKTREE_BLANK_AGENT,
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'claude' },
      detectedAgentIds: new Set(['claude'])
    })

    expect(resolved).toEqual({
      selectedAgent: NEW_WORKTREE_BLANK_AGENT,
      agentOverridden: true
    })
  })

  it('leaves closed modal state untouched', () => {
    const selected = newWorktreeAgentOptionFor('codex')
    const resolved = resolveNewWorktreeAgentSelection({
      visible: false,
      selectedAgent: selected,
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'claude' },
      detectedAgentIds: new Set(['claude'])
    })

    expect(resolved).toEqual({ selectedAgent: selected, agentOverridden: true })
  })

  it('uses blank when no detected agent is known', () => {
    expect(pickPreferredNewWorktreeAgent({ defaultTuiAgent: null }, new Set()).id).toBe('__blank__')
  })
})
