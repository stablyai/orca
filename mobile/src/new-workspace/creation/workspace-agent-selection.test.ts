import { describe, expect, it } from 'vitest'

import { resolveWorkspaceAgentSelection } from './workspace-agent-selection'

describe('workspace agent selection', () => {
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
