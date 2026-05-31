import { describe, expect, it } from 'vitest'

import {
  normalizeWorkspaceAgent,
  pickWorkspaceAgent,
  resolveWorkspaceAgentSelection,
  workspaceAgentLabel
} from './workspace-agent-selection'

describe('workspace agent selection', () => {
  it('uses an installed explicit default agent', () => {
    expect(pickWorkspaceAgent({ defaultTuiAgent: 'codex' }, new Set(['claude', 'codex']))).toBe(
      'codex'
    )
  })

  it('falls back by desktop auto-pick order when the default is unavailable on the target host', () => {
    expect(pickWorkspaceAgent({ defaultTuiAgent: 'codex' }, new Set(['claude']))).toBe('claude')
  })

  it('skips disabled preferred and fallback agents', () => {
    expect(
      pickWorkspaceAgent(
        { defaultTuiAgent: 'codex', disabledTuiAgents: ['codex'] },
        new Set(['claude', 'codex'])
      )
    ).toBe('claude')
    expect(
      pickWorkspaceAgent(
        { defaultTuiAgent: null, disabledTuiAgents: ['claude', 'codex', 'not-real'] },
        new Set(['claude', 'codex'])
      )
    ).toBe('blank')
  })

  it('honors blank terminal as an explicit no-agent preference', () => {
    expect(pickWorkspaceAgent({ defaultTuiAgent: 'blank' }, new Set(['claude', 'codex']))).toBe(
      'blank'
    )
  })

  it('returns blank when detection completed and no known agent exists', () => {
    expect(pickWorkspaceAgent({ defaultTuiAgent: null }, new Set(['unknown-agent']))).toBe('blank')
  })

  it('uses the preferred/default display value while detection is still pending', () => {
    expect(pickWorkspaceAgent({ defaultTuiAgent: 'codex' }, null)).toBe('codex')
    expect(pickWorkspaceAgent({ defaultTuiAgent: null }, null)).toBe('claude')
    expect(
      pickWorkspaceAgent({ defaultTuiAgent: 'codex', disabledTuiAgents: ['codex'] }, null)
    ).toBe('claude')
  })

  it('normalizes legacy blank sentinel and labels known choices', () => {
    expect(normalizeWorkspaceAgent('__blank__')).toBe('blank')
    expect(workspaceAgentLabel('codex')).toBe('Codex')
  })

  it('keeps automatic selection current while create selection is active', () => {
    expect(
      resolveWorkspaceAgentSelection({
        selectionActive: true,
        settings: { defaultTuiAgent: 'codex' },
        detectedAgentIds: new Set(['claude', 'codex']),
        agent: null,
        overridden: false
      })
    ).toEqual({ agent: 'codex', overridden: false })
  })

  it('preserves a valid user override', () => {
    expect(
      resolveWorkspaceAgentSelection({
        selectionActive: true,
        settings: { defaultTuiAgent: 'claude' },
        detectedAgentIds: new Set(['claude', 'codex']),
        agent: 'codex',
        overridden: true
      })
    ).toEqual({ agent: 'codex', overridden: true })
  })

  it('falls back when a user override is unavailable after detection settles', () => {
    expect(
      resolveWorkspaceAgentSelection({
        selectionActive: true,
        settings: { defaultTuiAgent: 'codex' },
        detectedAgentIds: new Set(['claude']),
        agent: 'codex',
        overridden: true
      })
    ).toEqual({ agent: 'claude', overridden: false })
  })

  it('does not repair inactive selection state', () => {
    expect(
      resolveWorkspaceAgentSelection({
        selectionActive: false,
        settings: { defaultTuiAgent: 'codex' },
        detectedAgentIds: new Set(['codex']),
        agent: null,
        overridden: false
      })
    ).toEqual({ agent: null, overridden: false })
  })
})
