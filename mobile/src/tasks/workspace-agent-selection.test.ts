import { describe, expect, it } from 'vitest'

import type { BuiltInTuiAgent, TuiAgent } from '../../../src/shared/types'
import {
  normalizeWorkspaceAgent,
  pickWorkspaceAgent,
  resolveWorkspaceAgentSelection,
  workspaceAgentLabel
} from './workspace-agent-selection'

const customClaudeId = 'custom-agent:claude:one' as TuiAgent
const customBases: ReadonlyMap<TuiAgent, BuiltInTuiAgent> = new Map([[customClaudeId, 'claude']])

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
    expect(workspaceAgentLabel(customClaudeId, new Map([[customClaudeId, 'My Claude']]))).toBe(
      'My Claude'
    )
  })

  it('accepts a custom default only when the catalog vouches for it', () => {
    expect(normalizeWorkspaceAgent(customClaudeId)).toBe(null)
    expect(normalizeWorkspaceAgent(customClaudeId, customBases)).toBe(customClaudeId)
    expect(normalizeWorkspaceAgent('custom-agent:claude:other', customBases)).toBe(null)
  })

  it('uses a custom default when its base harness is detected', () => {
    expect(
      pickWorkspaceAgent(
        { defaultTuiAgent: customClaudeId },
        new Set(['claude', 'codex']),
        customBases
      )
    ).toBe(customClaudeId)
  })

  it('uses a custom default while detection is still pending', () => {
    expect(pickWorkspaceAgent({ defaultTuiAgent: customClaudeId }, null, customBases)).toBe(
      customClaudeId
    )
  })

  it('falls back to auto-pick when the custom default base is not detected', () => {
    expect(
      pickWorkspaceAgent({ defaultTuiAgent: customClaudeId }, new Set(['codex']), customBases)
    ).toBe('codex')
  })

  it('falls back to auto-pick when a custom default is missing from the catalog', () => {
    expect(
      pickWorkspaceAgent({ defaultTuiAgent: customClaudeId }, new Set(['claude', 'codex']))
    ).toBe('claude')
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

  it('selects a catalog-backed custom default while un-overridden', () => {
    expect(
      resolveWorkspaceAgentSelection({
        selectionActive: true,
        settings: { defaultTuiAgent: customClaudeId },
        detectedAgentIds: new Set(['claude', 'codex']),
        customAgentBases: customBases,
        agent: null,
        overridden: false
      })
    ).toEqual({ agent: customClaudeId, overridden: false })
  })

  it('keeps a custom override while its base harness is detected', () => {
    expect(
      resolveWorkspaceAgentSelection({
        selectionActive: true,
        settings: { defaultTuiAgent: 'codex' },
        detectedAgentIds: new Set(['claude', 'codex']),
        customAgentBases: customBases,
        agent: customClaudeId,
        overridden: true
      })
    ).toEqual({ agent: customClaudeId, overridden: true })
  })

  it('repairs a custom override when its base harness is not detected', () => {
    expect(
      resolveWorkspaceAgentSelection({
        selectionActive: true,
        settings: { defaultTuiAgent: 'codex' },
        detectedAgentIds: new Set(['codex']),
        customAgentBases: customBases,
        agent: customClaudeId,
        overridden: true
      })
    ).toEqual({ agent: 'codex', overridden: false })
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
