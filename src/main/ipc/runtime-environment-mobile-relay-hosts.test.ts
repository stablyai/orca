import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const environments: Record<string, unknown>[] = []
  const snapshots: Record<string, unknown>[] = []
  const sshTargets: { id: string; label: string }[] = []
  const sshStates = new Map<string, Record<string, unknown>>()
  return { environments, snapshots, sshTargets, sshStates, resolveManaged: vi.fn(), call: vi.fn() }
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
vi.mock('../ssh/ssh-target-registry', () => ({
  listRegisteredSshTargets: () => mocks.sshTargets,
  getRegisteredSshState: (targetId: string) => mocks.sshStates.get(targetId)
}))
vi.mock('./runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusSnapshots: () => mocks.snapshots
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
    mocks.snapshots = []
  })

  it("lists configured servers with the desktop's own status, ignoring another pairing's snapshot", () => {
    mocks.environments = [
      { id: 'env-1', name: 'VM', createdAt: 1, pairingRevision: 7, runtimeId: 'runtime-a' },
      { id: 'env-2', name: 'Box', createdAt: 2, runtimeId: null, source: 'ephemeral-vm' }
    ]
    const status = { runtimeId: 'runtime-a', capabilities: [] }
    mocks.snapshots = [
      {
        environmentId: 'env-1',
        pairingRevision: 7,
        checkedAt: 5,
        status,
        verification: 'verified',
        transport: 'ready'
      },
      {
        environmentId: 'env-2',
        pairingRevision: 1,
        checkedAt: 5,
        status,
        verification: 'verified',
        transport: 'ready'
      },
      {
        environmentId: 'removed',
        pairingRevision: 1,
        checkedAt: 5,
        status,
        verification: 'verified',
        transport: 'ready'
      }
    ]
    mocks.sshTargets = [
      { id: 'devbox', label: 'Dev Box' },
      { id: 'never-connected', label: 'Pi' }
    ]
    const devboxState = { targetId: 'devbox', status: 'connected' }
    mocks.sshStates.set('devbox', devboxState)
    const listing = createRuntimeEnvironmentMobileRelayHosts().list()
    expect(listing.sshTargetLabels).toEqual(
      new Map([
        ['devbox', 'Dev Box'],
        ['never-connected', 'Pi']
      ])
    )
    expect(listing.sshConnectionStates).toEqual(new Map([['devbox', devboxState]]))
    expect(listing.environments).toEqual([
      {
        id: 'env-1',
        name: 'VM',
        source: undefined,
        orcadDeployment: undefined,
        pairingRevision: 7,
        runtimeId: 'runtime-a'
      },
      {
        id: 'env-2',
        name: 'Box',
        source: 'ephemeral-vm',
        orcadDeployment: undefined,
        pairingRevision: 2,
        runtimeId: null
      }
    ])
    expect([...listing.statusByEnvironmentId.keys()]).toEqual(['env-1'])
    expect(listing.statusByEnvironmentId.get('env-1')).toMatchObject({ status, checkedAt: 5 })
    expect(mocks.resolveManaged).not.toHaveBeenCalled()
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
    expect(mocks.call).toHaveBeenLastCalledWith(
      '/user-data',
      'env-1',
      'status.get',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
    // A bounded call refused by the transport once the server was re-paired or replaced.
    await hosts.call(
      { environmentId: 'env-1' },
      'worktree.ps',
      {},
      {
        timeoutMs: 5_000,
        expected: { pairingRevision: 7, runtimeId: 'runtime-a' }
      }
    )
    expect(mocks.call).toHaveBeenLastCalledWith(
      '/user-data',
      'env-1',
      'worktree.ps',
      {},
      5_000,
      7,
      undefined,
      { expectedEnvironmentRuntimeId: 'runtime-a' }
    )

    const retired: string[] = []
    const stop = hosts.onEnvironmentRetired((id) => retired.push(id))
    retireMobileDesktopRelayEnvironment('env-1')
    stop()
    retireMobileDesktopRelayEnvironment('env-1')
    expect(retired).toEqual(['env-1'])
  })
})
