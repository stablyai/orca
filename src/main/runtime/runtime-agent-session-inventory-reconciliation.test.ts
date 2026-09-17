import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionOwners } from '../ipc/pty/pane/agent-session-owners'
import { reconcileRuntimeAgentSessionInventory } from './runtime-agent-session-inventory-reconciliation'

const owner = {
  claim: {
    digestVersion: 1 as const,
    keyId: 'key',
    identityDigest: 'a'.repeat(43),
    worktreeScopeDigest: 'b'.repeat(43),
    agent: 'codex' as const
  },
  generation: 'generation-1',
  phase: 'live' as const,
  ptyId: 'local-pty',
  surface: {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: '11111111-1111-4111-8111-111111111111',
    terminalHandle: `term_${'a'.repeat(32)}`
  },
  statusBinding: {
    runId: 'run-1',
    attachment: { executionId: 'execution-1' },
    role: 'root' as const
  }
}

afterEach(() => {
  agentSessionOwners.release(owner.ptyId)
})

describe('runtime launch-owner inventory reconciliation', () => {
  it('includes the current-runtime local owner when the local provider omits owner metadata', () => {
    agentSessionOwners.register(owner)
    const onReconciled = vi.fn()

    reconcileRuntimeAgentSessionInventory({
      sessions: [{ id: owner.ptyId, cwd: '/workspace', title: 'shell' }],
      connectionId: null,
      queriedHostIds: new Set(['local']),
      knownHostIds: new Set(['local']),
      onReconciled
    })

    expect(onReconciled).toHaveBeenCalledWith(
      expect.objectContaining({ complete: true, connectionId: null, discoveries: [] })
    )
    expect(onReconciled.mock.calls[0]?.[0].owners).toEqual([owner])
  })
})
