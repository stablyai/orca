import { expect, it } from 'vitest'
import { resolveWorkspaceAgentSelection } from './workspace-agent-selection'

it('keeps the host-resolved choice authoritative until a valid explicit override', () => {
  const current = {
    selectionActive: true,
    settings: { defaultTuiAgent: 'claude' as const },
    detectedAgentIds: new Set(['claude']),
    agent: 'claude' as const,
    overridden: false
  }
  expect(resolveWorkspaceAgentSelection({ ...current, resolvedDefaultAgent: 'codex' })).toEqual({
    agent: 'codex',
    overridden: false
  })
  expect(resolveWorkspaceAgentSelection({ ...current, resolvedDefaultAgent: null })).toEqual({
    agent: 'blank',
    overridden: false
  })
  expect(
    resolveWorkspaceAgentSelection({
      ...current,
      resolvedDefaultAgent: 'codex',
      overridden: true
    })
  ).toEqual({ agent: 'claude', overridden: true })
})
