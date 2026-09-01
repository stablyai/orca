import { describe, expect, it, vi } from 'vitest'
import type { AgentCatalogSnapshot } from '../../../src/shared/agent-catalog-snapshot'
import type { RpcClient } from '../transport/rpc-client'
import { newWorktreeAgentOptionFor } from './new-worktree-agent-selection'
import { resolveNewWorktreeAgentIdentitySupport } from './new-worktree-agent-identity-support'

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

describe('new worktree agent identity support', () => {
  it('keeps a catalog-backed custom on identity launch after a transient status failure', async () => {
    const client = { sendRequest: vi.fn().mockRejectedValue(new Error('temporary')) }
    await expect(
      resolveNewWorktreeAgentIdentitySupport({
        client: client as unknown as RpcClient,
        selectedAgent: newWorktreeAgentOptionFor('custom-agent:claude:one', catalog),
        catalogSnapshot: catalog
      })
    ).resolves.toBe(true)
  })

  it('does not infer identity support for a built-in from the custom catalog', async () => {
    const client = { sendRequest: vi.fn().mockRejectedValue(new Error('temporary')) }
    await expect(
      resolveNewWorktreeAgentIdentitySupport({
        client: client as unknown as RpcClient,
        selectedAgent: newWorktreeAgentOptionFor('claude'),
        catalogSnapshot: catalog
      })
    ).resolves.toBe(false)
  })

  it('honors an explicit status response that lacks identity support', async () => {
    const client = { sendRequest: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
    await expect(
      resolveNewWorktreeAgentIdentitySupport({
        client: client as unknown as RpcClient,
        selectedAgent: newWorktreeAgentOptionFor('custom-agent:claude:one', catalog),
        catalogSnapshot: catalog
      })
    ).resolves.toBe(false)
  })
})
