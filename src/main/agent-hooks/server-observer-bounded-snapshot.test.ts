import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { seedLegacyAgentStatusForTests } from '../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../shared/stable-pane-id'

describe('AgentHookServer observer producer bound', () => {
  it('scans and materializes bounded scoped rows without using the full snapshot', () => {
    const server = new AgentHookServer()
    const state = server._getStateForTests()
    // Seed the actual server backing source beyond the observer scan cap so this regression
    // proves the observer producer never allocates the full collection.
    for (let index = 0; index < 1_100; index += 1) {
      const leafId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
      const paneKey = makePaneKey(`tab-${index}`, leafId)
      seedLegacyAgentStatusForTests(state, {
        paneKey,
        tabId: `tab-${index}`,
        worktreeId: index % 2 === 0 ? 'worktree-in-scope' : 'other-worktree',
        connectionId: null,
        payload: {
          state: 'working',
          prompt: `fictional-${index}`,
          agentType: 'codex'
        }
      })
    }

    const fullSnapshot = vi.spyOn(server, 'getStatusSnapshot')
    const observed = server.getBoundedStatusSnapshot('worktree-in-scope', 1_024, 256)

    expect(fullSnapshot).not.toHaveBeenCalled()
    expect(observed.truncated).toBe(true)
    expect(observed.rows).toHaveLength(256)
    expect(observed.rows.every((row) => row.worktreeId === 'worktree-in-scope')).toBe(true)
    expect(observed.rows.at(0)?.tabId).toBe('tab-0')
    expect(observed.rows.at(-1)?.tabId).toBe('tab-510')
  })
})
