import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  clearMobileAgentModelDiscoveryForTests,
  discoverMobileAgentCatalogModels
} from './mobile-agent-model-discovery'

function probeResponse(): { ok: true; result: unknown } {
  return {
    ok: true,
    result: {
      success: true,
      catalogOrigin: 'probe',
      models: [
        { id: 'opus', label: 'Opus' },
        { id: 'opus[1m]', label: 'Opus (1M context)' }
      ]
    }
  }
}

function makeClient(): { sendRequest: ReturnType<typeof vi.fn> } {
  return { sendRequest: vi.fn() }
}

function discover(
  client: { sendRequest: ReturnType<typeof vi.fn> },
  overrides?: { hostId?: string; worktreeId?: string }
): Promise<unknown> {
  return discoverMobileAgentCatalogModels({
    client: client as unknown as RpcClient,
    hostId: overrides?.hostId ?? 'host-a',
    worktreeId: overrides?.worktreeId ?? 'wt-1',
    agent: 'claude'
  })
}

describe('discoverMobileAgentCatalogModels', () => {
  beforeEach(() => {
    clearMobileAgentModelDiscoveryForTests()
  })

  it('returns the host list and probes a given worktree only once', async () => {
    const client = makeClient()
    client.sendRequest.mockResolvedValue(probeResponse())

    const models = await discover(client)
    expect(models).toEqual([
      expect.objectContaining({ id: 'opus' }),
      expect.objectContaining({ id: 'opus[1m]' })
    ])
    expect(client.sendRequest.mock.calls[0]?.[0]).toBe('git.discoverCommitMessageModels')
    expect(client.sendRequest.mock.calls[0]?.[1]).toEqual({
      worktree: 'id:wt-1',
      agentId: 'claude'
    })

    await discover(client)
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('probes each host and worktree separately', async () => {
    const client = makeClient()
    client.sendRequest.mockResolvedValue(probeResponse())

    await discover(client)
    await discover(client, { worktreeId: 'wt-2' })
    await discover(client, { hostId: 'host-b' })
    expect(client.sendRequest).toHaveBeenCalledTimes(3)
  })

  it('stops probing a host that does not support the method, for every worktree', async () => {
    const client = makeClient()
    client.sendRequest.mockResolvedValue({
      ok: false,
      error: { code: 'method_not_found', message: 'unknown method' }
    })

    expect(await discover(client)).toBeNull()
    expect(await discover(client, { worktreeId: 'wt-2' })).toBeNull()
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('retries after a transport failure instead of pinning the seed for the session', async () => {
    const client = makeClient()
    client.sendRequest.mockRejectedValueOnce(new Error('Request timed out'))
    expect(await discover(client)).toBeNull()

    client.sendRequest.mockResolvedValue(probeResponse())
    expect(await discover(client)).toHaveLength(2)
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('keeps the seed when the host answers with a spec list rather than a probe', async () => {
    const client = makeClient()
    client.sendRequest.mockResolvedValue({
      ok: true,
      result: {
        success: true,
        catalogOrigin: 'spec',
        models: [{ id: 'opus', label: 'Opus' }]
      }
    })
    expect(await discover(client)).toBeNull()
    // A definitive host answer is cached; only transport failures retry.
    expect(await discover(client)).toBeNull()
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })
})
