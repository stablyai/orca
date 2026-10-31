import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const environments: Record<string, unknown>[] = []
  const snapshots: Record<string, unknown>[] = []
  const sshTargets: { id: string; label: string }[] = []
  const sshStates = new Map<string, Record<string, unknown>>()
  return {
    environments,
    snapshots,
    sshTargets,
    sshStates,
    resolveManaged: vi.fn(),
    call: vi.fn(),
    wslGateOpen: false,
    wslReach: new Map<string, string>()
  }
})

vi.mock('electron', () => ({ app: { getPath: () => '/user-data' } }))
vi.mock('../../../shared/runtime-environment-store', () => ({
  listEnvironments: () => mocks.environments
}))
vi.mock('../../../shared/runtime-environments', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPreferredPairingOffer: (environment: { endpoint: string }) => ({
    endpoint: environment.endpoint
  })
}))
vi.mock('./runtime-environment-managed-tunnel', () => ({
  resolveManagedRuntimeEnvironment: mocks.resolveManaged
}))
vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  listRegisteredSshTargets: () => mocks.sshTargets,
  getRegisteredSshState: (targetId: string) => mocks.sshStates.get(targetId)
}))
vi.mock('./runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusSnapshots: () => mocks.snapshots
}))
vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.call
}))
vi.mock('../../wsl/wsl-host-gate', () => ({ wslHostsGateOpen: () => mocks.wslGateOpen }))
vi.mock('../../wsl/wsl-host-service-instance', () => ({
  getWslHostPhoneGate: () => ({
    // Every recorded host, as the gate lists them; one not set is unavailable.
    reachAll: () => new Map([['wsl:ubuntu', mocks.wslReach.get('wsl:ubuntu') ?? 'unavailable']])
  })
}))

const NO_WSL_START = { wslStart: 'never' }
const WSL_HOST = {
  id: 'wsl:ubuntu',
  name: 'Ubuntu (WSL)',
  createdAt: 2,
  runtimeId: null,
  orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
}

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
    mocks.wslGateOpen = false
    mocks.wslReach.clear()
  })

  it('keeps WSL hosts away from phones while their internal gate is closed', async () => {
    mocks.environments = [{ id: 'env-1', name: 'VM', createdAt: 1, runtimeId: null }, WSL_HOST]
    const hosts = createRuntimeEnvironmentMobileRelayHosts()
    expect(hosts.list().environments.map((environment) => environment.id)).toEqual(['env-1'])
    await expect(hosts.resolve('wsl:ubuntu')).resolves.toBeNull()
    expect(mocks.resolveManaged).not.toHaveBeenCalled()
  })

  it('relays a WSL host behind the gate, never starting its distro for a phone', async () => {
    mocks.wslGateOpen = true
    mocks.environments = [WSL_HOST]
    mocks.resolveManaged.mockResolvedValue({ ...WSL_HOST, endpoint: 'ws://127.0.0.1:42000' })
    const hosts = createRuntimeEnvironmentMobileRelayHosts()
    expect(hosts.list().environments.map((environment) => environment.id)).toEqual(['wsl:ubuntu'])
    await hosts.resolve('wsl:ubuntu')
    expect(mocks.resolveManaged).toHaveBeenCalledWith('/user-data', 'wsl:ubuntu', NO_WSL_START)
  })

  it("counts a WSL host's last status only while the desktop holds it connected", () => {
    mocks.wslGateOpen = true
    mocks.environments = [{ ...WSL_HOST, pairingRevision: 3 }]
    mocks.snapshots = [
      {
        environmentId: 'wsl:ubuntu',
        pairingRevision: 3,
        checkedAt: 5,
        status: { runtimeId: 'r', capabilities: [] },
        verification: 'verified',
        transport: 'ready'
      }
    ]
    const hosts = createRuntimeEnvironmentMobileRelayHosts()
    expect([...hosts.list().statusByEnvironmentId.keys()]).toEqual([])
    mocks.wslReach.set('wsl:ubuntu', 'ready')
    expect([...hosts.list().statusByEnvironmentId.keys()]).toEqual(['wsl:ubuntu'])
  })

  it('marks a WSL host stopped only on a confirmed stop, and hides it while it may not run', () => {
    mocks.wslGateOpen = true
    mocks.environments = [WSL_HOST]
    const hosts = createRuntimeEnvironmentMobileRelayHosts()
    // Starting, reconnecting or unconfirmed: listed as not connected here, with no stop claimed.
    expect(hosts.list().environments[0]).toMatchObject({ unavailableOnDesktop: true })
    expect(hosts.list().environments[0]).not.toHaveProperty('stoppedOnDesktop')
    mocks.wslReach.set('wsl:ubuntu', 'stopped')
    expect(hosts.list().environments[0]).toMatchObject({ stoppedOnDesktop: true })
    expect(hosts.list().environments[0]).not.toHaveProperty('unavailableOnDesktop')
    mocks.wslReach.set('wsl:ubuntu', 'ready')
    expect(hosts.list().environments[0]).not.toHaveProperty('unavailableOnDesktop')
    // The Experimental switch is off: the gate alone does not list it.
    mocks.wslReach.set('wsl:ubuntu', 'hidden')
    expect(hosts.list().environments).toEqual([])
  })

  it('relays SSH-managed servers, with and without the persisted deployment kind', async () => {
    const tunnel = { sshTargetId: 't', sshTargetGeneration: 1, localPort: 1, remotePort: 2 }
    mocks.environments = [
      { id: 'legacy', name: 'A', createdAt: 1, runtimeId: null, orcadDeployment: tunnel },
      {
        id: 'managed',
        name: 'B',
        createdAt: 2,
        runtimeId: null,
        orcadDeployment: { kind: 'ssh', ...tunnel }
      }
    ]
    const hosts = createRuntimeEnvironmentMobileRelayHosts()
    expect(hosts.list().environments.map((environment) => environment.id)).toEqual([
      'legacy',
      'managed'
    ])
    await hosts.resolve('managed')
    expect(mocks.resolveManaged).toHaveBeenCalledWith('/user-data', 'managed', NO_WSL_START)
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
    expect(mocks.resolveManaged).toHaveBeenCalledWith('/user-data', 'env-1', NO_WSL_START)
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
      { preparation: NO_WSL_START }
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
      { preparation: NO_WSL_START, expectedEnvironmentRuntimeId: 'runtime-a' }
    )

    const retired: string[] = []
    const stop = hosts.onEnvironmentRetired((id) => retired.push(id))
    retireMobileDesktopRelayEnvironment('env-1')
    stop()
    retireMobileDesktopRelayEnvironment('env-1')
    expect(retired).toEqual(['env-1'])
  })
})
