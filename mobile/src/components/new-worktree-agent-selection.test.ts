import { describe, expect, it } from 'vitest'

import type { AgentCatalogSnapshot } from '../../../src/shared/agent-catalog-snapshot'
import type { TuiAgent } from '../../../src/shared/types'
import {
  buildNewWorktreePickerOptions,
  buildSelectableNewWorktreeAgentOptions,
  hostDefaultMatchesNewWorktreePreview,
  NEW_WORKTREE_BLANK_AGENT,
  newWorktreeAgentOptionFor,
  pickPreferredNewWorktreeAgent,
  resolveNewWorktreeAgentSelection,
  type NewWorktreeAgentOption
} from './new-worktree-agent-selection'

function catalogWithClaudeCustom(): AgentCatalogSnapshot {
  return {
    version: 1,
    revision: 4,
    defaultAgent: 'auto',
    disabledAgents: [],
    customAgents: [
      {
        id: 'custom-agent:claude:one',
        baseAgent: 'claude',
        label: 'My Claude',
        args: '',
        syncEnv: false,
        status: 'ready',
        envState: 'none',
        availabilityCheck: 'baseline-detection'
      }
    ],
    deletedCustomAgents: []
  }
}

const claudeCustomOption: NewWorktreeAgentOption = {
  id: 'custom-agent:claude:one' as TuiAgent,
  label: 'My Claude',
  isCustom: true,
  baseAgent: 'claude'
}

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

  it('resolves a custom id to its catalog row', () => {
    expect(newWorktreeAgentOptionFor('custom-agent:claude:one', catalogWithClaudeCustom())).toEqual(
      claudeCustomOption
    )
    expect(newWorktreeAgentOptionFor('custom-agent:claude:one')).toEqual(NEW_WORKTREE_BLANK_AGENT)
  })

  it('previews a custom host default when its base harness is detected', () => {
    const preferred = pickPreferredNewWorktreeAgent(
      { defaultTuiAgent: 'custom-agent:claude:one' as TuiAgent },
      new Set(['claude', 'codex']),
      catalogWithClaudeCustom()
    )
    expect(preferred).toEqual(claudeCustomOption)
  })

  it('previews a custom host default while detection is pending', () => {
    const preferred = pickPreferredNewWorktreeAgent(
      { defaultTuiAgent: 'custom-agent:claude:one' as TuiAgent },
      null,
      catalogWithClaudeCustom()
    )
    expect(preferred).toEqual(claudeCustomOption)
  })

  it('falls back to auto-pick when the custom default base is not detected', () => {
    const preferred = pickPreferredNewWorktreeAgent(
      { defaultTuiAgent: 'custom-agent:claude:one' as TuiAgent },
      new Set(['codex']),
      catalogWithClaudeCustom()
    )
    expect(preferred).toEqual(newWorktreeAgentOptionFor('codex'))
  })

  it('falls back to auto-pick for a custom default without a catalog snapshot', () => {
    const preferred = pickPreferredNewWorktreeAgent(
      { defaultTuiAgent: 'custom-agent:claude:one' as TuiAgent },
      new Set(['claude', 'codex'])
    )
    expect(preferred).toEqual(newWorktreeAgentOptionFor('claude'))
  })

  it('selects the custom host default while un-overridden', () => {
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: newWorktreeAgentOptionFor('claude'),
      agentOverridden: false,
      runtimeSettings: { defaultTuiAgent: 'custom-agent:claude:one' as TuiAgent },
      detectedAgentIds: new Set(['claude', 'codex']),
      catalogSnapshot: catalogWithClaudeCustom()
    })

    expect(resolved).toEqual({ selectedAgent: claudeCustomOption, agentOverridden: false })
  })

  it('ignores a disabled custom default from the catalog', () => {
    const snapshot = catalogWithClaudeCustom()
    snapshot.disabledAgents = ['custom-agent:claude:one' as TuiAgent]
    const preferred = pickPreferredNewWorktreeAgent(
      { defaultTuiAgent: 'custom-agent:claude:one' as TuiAgent },
      new Set(['claude', 'codex']),
      snapshot
    )
    expect(preferred).toEqual(newWorktreeAgentOptionFor('claude'))
  })

  it('keeps a custom override when its base harness is detected', () => {
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: claudeCustomOption,
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'codex' },
      detectedAgentIds: new Set(['claude', 'codex'])
    })

    expect(resolved).toEqual({ selectedAgent: claudeCustomOption, agentOverridden: true })
  })

  it('repairs a custom override when its base harness is not detected', () => {
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: claudeCustomOption,
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'codex' },
      detectedAgentIds: new Set(['codex'])
    })

    expect(resolved).toEqual({
      selectedAgent: newWorktreeAgentOptionFor('codex'),
      agentOverridden: false
    })
  })
})

describe('hostDefaultMatchesNewWorktreePreview', () => {
  it('matches when detection leaves the host default intact', () => {
    expect(
      hostDefaultMatchesNewWorktreePreview({ defaultTuiAgent: 'claude' }, new Set(['claude']))
    ).toBe(true)
  })

  it('does not match when detection narrowed the preview away from the host default', () => {
    // Deferring here would launch claude, which the target does not have.
    expect(
      hostDefaultMatchesNewWorktreePreview({ defaultTuiAgent: 'claude' }, new Set(['codex']))
    ).toBe(false)
  })

  it('matches while detection is pending', () => {
    expect(hostDefaultMatchesNewWorktreePreview({ defaultTuiAgent: 'claude' }, null)).toBe(true)
  })

  it('does not match when a custom default lost its base harness', () => {
    expect(
      hostDefaultMatchesNewWorktreePreview(
        { defaultTuiAgent: 'custom-agent:claude:one' as TuiAgent },
        new Set(['codex']),
        catalogWithClaudeCustom()
      )
    ).toBe(false)
  })
})

describe('buildSelectableNewWorktreeAgentOptions', () => {
  it('returns only built-in rows for a null snapshot', () => {
    const options = buildSelectableNewWorktreeAgentOptions({
      snapshot: null,
      includeCustomAgents: true,
      detectedAgentIds: null,
      disabledTuiAgents: undefined
    })
    expect(options.every((option) => option.isCustom !== true)).toBe(true)
    expect(options.some((option) => option.id === '__blank__')).toBe(false)
  })

  it('shows a custom row when its base harness is detected', () => {
    const options = buildSelectableNewWorktreeAgentOptions({
      snapshot: catalogWithClaudeCustom(),
      includeCustomAgents: true,
      detectedAgentIds: new Set(['claude']),
      disabledTuiAgents: undefined
    })
    expect(options.some((option) => option.id === 'custom-agent:claude:one')).toBe(true)
  })

  it('hides a custom row when its base harness is not detected', () => {
    const options = buildSelectableNewWorktreeAgentOptions({
      snapshot: catalogWithClaudeCustom(),
      includeCustomAgents: true,
      detectedAgentIds: new Set(['codex']),
      disabledTuiAgents: undefined
    })
    expect(options.some((option) => option.id === 'custom-agent:claude:one')).toBe(false)
  })

  it('builds picker rows with customs included and blank terminal last', () => {
    const options = buildNewWorktreePickerOptions({
      snapshot: catalogWithClaudeCustom(),
      detectedAgentIds: new Set(['claude']),
      disabledTuiAgents: undefined
    })
    expect(options.some((option) => option.id === 'custom-agent:claude:one')).toBe(true)
    expect(options.at(-1)).toEqual(NEW_WORKTREE_BLANK_AGENT)
  })

  it('omits customs when the gate flag is off even with a snapshot', () => {
    const options = buildSelectableNewWorktreeAgentOptions({
      snapshot: catalogWithClaudeCustom(),
      includeCustomAgents: false,
      detectedAgentIds: null,
      disabledTuiAgents: undefined
    })
    expect(options.every((option) => option.isCustom !== true)).toBe(true)
  })
})
