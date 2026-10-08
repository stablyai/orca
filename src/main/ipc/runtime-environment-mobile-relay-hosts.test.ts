import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const environments: { id: string; name: string }[] = []
  return { environments, resolveManaged: vi.fn(), call: vi.fn() }
})

vi.mock('electron', () => ({ app: { getPath: () => '/user-data' } }))
vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: () => mocks.environments
}))
vi.mock('../../shared/runtime-environments', () => ({
  getPreferredPairingOffer: (environment: { endpoint: string }) => ({
    endpoint: environment.endpoint
  })
}))
vi.mock('./runtime-environment-managed-tunnel', () => ({
  resolveManagedRuntimeEnvironment: mocks.resolveManaged
}))
vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.call
}))

import {
  createRuntimeEnvironmentMobileRelayHosts,
  retireMobileDesktopRelayEnvironment
} from './runtime-environment-mobile-relay-hosts'

describe('runtime environment mobile relay hosts', () => {
  beforeEach(() => {
    mocks.environments = [{ id: 'env-1', name: 'VM' }]
    mocks.resolveManaged.mockReset().mockResolvedValue({
      id: 'env-1',
      endpoint: 'ws://vm:6768',
      pairingRevision: 7,
      createdAt: 1,
      runtimeId: 'runtime-a'
    })
    mocks.call.mockReset()
  })

  it('resolves a configured server by exact id, fenced by pairing revision and runtime identity', async () => {
    const hosts = createRuntimeEnvironmentMobileRelayHosts()
    await expect(hosts.resolve('env-1')).resolves.toEqual({
      environmentId: 'env-1',
      fence: '7\0runtime-a',
      pairing: { endpoint: 'ws://vm:6768' }
    })
    expect(mocks.resolveManaged).toHaveBeenCalledWith('/user-data', 'env-1')
  })

  it('answers null for a name, an unknown id or a removed server, without resolving it', async () => {
    const hosts = createRuntimeEnvironmentMobileRelayHosts()
    await expect(hosts.resolve('VM')).resolves.toBeNull()
    await expect(hosts.resolve('env-2')).resolves.toBeNull()
    mocks.environments = []
    await expect(hosts.resolve('env-1')).resolves.toBeNull()
    expect(mocks.resolveManaged).not.toHaveBeenCalled()
  })

  it('calls the server as the desktop and reports retirements until unsubscribed', async () => {
    const hosts = createRuntimeEnvironmentMobileRelayHosts()
    mocks.call.mockResolvedValue({ id: 'x', ok: true, result: {}, _meta: { runtimeId: 'r' } })
    const host = (await hosts.resolve('env-1'))!
    await hosts.call(host, 'status.get', undefined)
    expect(mocks.call).toHaveBeenCalledWith('/user-data', 'env-1', 'status.get', undefined)

    const retired: string[] = []
    const stop = hosts.onEnvironmentRetired((id) => retired.push(id))
    retireMobileDesktopRelayEnvironment('env-1')
    stop()
    retireMobileDesktopRelayEnvironment('env-1')
    expect(retired).toEqual(['env-1'])
  })
})
