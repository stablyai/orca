import { describe, expect, it } from 'vitest'
import type { AgentCatalogSnapshot } from '../../../src/shared/agent-catalog-snapshot'
import { buildTaskWorkspaceAgentCatalog } from './task-workspace-agent-catalog'

const catalog: AgentCatalogSnapshot = {
  version: 1,
  revision: 1,
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

describe('task workspace agent catalog', () => {
  it('provides custom bases and labels when the base harness is detected', () => {
    const projection = buildTaskWorkspaceAgentCatalog(catalog, new Set(['claude']), [])
    expect(projection.rows.map((row) => row.id)).toEqual(['claude', 'custom-agent:claude:one'])
    expect(projection.customAgentBases.get('custom-agent:claude:one')).toBe('claude')
    expect(projection.customAgentLabels.get('custom-agent:claude:one')).toBe('My Claude')
  })

  it('hides custom rows when their base harness is unavailable', () => {
    const projection = buildTaskWorkspaceAgentCatalog(catalog, new Set(['codex']))
    expect(projection.rows.some((row) => row.isCustom)).toBe(false)
  })
})
