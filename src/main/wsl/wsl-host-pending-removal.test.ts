import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  findWslHostDeployment,
  setWslHostPendingStop
} from '../../shared/runtime-environment-wsl-host-store'
import type { WslHostStatus } from '../../shared/wsl-host-types'
import { WslHostService, type WslHostConnector } from './wsl-host-service'
import { UBUNTU, UBUNTU_ID, makeConnector } from './wsl-host-service-test-connector'
import { rememberWslHostsToWake, wakeRememberedWslHosts } from './wsl-host-early-wake'

// E11: a Remove that can't prove the host's server stopped keeps the host, pending.
describe('WslHostService pending removal', () => {
  let userDataPath: string
  let published: WslHostStatus[]
  const removed = vi.fn()

  function makeService(connector: WslHostConnector): WslHostService {
    const service = new WslHostService({
      userDataPath: () => userDataPath,
      isEnabled: () => true,
      hasServerFiles: () => true,
      publish: (status) => published.push(status),
      pairingChanged: vi.fn(),
      ready: vi.fn(),
      removed
    })
    service.attach(connector)
    return service
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-host-pending-removal-'))
    published = []
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('keeps a host whose server it could not stop, pending, and nothing reconnects it', async () => {
    const connector = makeConnector([UBUNTU])
    connector.stopServer.mockResolvedValueOnce({
      stopped: false,
      reason: '1 terminal kept running',
      verdict: 'live'
    })
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    connector.connect.mockClear()

    await expect(service.remove('wsl:ubuntu')).resolves.toEqual({
      stopped: false,
      reason: '1 terminal kept running',
      verdict: 'live',
      kept: true
    })
    expect(listEnvironments(userDataPath)).toHaveLength(1)
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.pendingStop).toMatchObject({
      reason: '1 terminal kept running',
      verdict: 'live'
    })
    expect(removed).not.toHaveBeenCalled()
    expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')
    expect(published.at(-1)).toMatchObject({
      state: 'closed',
      detail: '1 terminal kept running',
      removalPending: true
    })
    // Open work, liveness and passive calls leave it alone.
    expect(service.hasUserVisibleWork('Ubuntu')).toBe(false)
    service.setVisibleWork([])
    service.setVisibleWork(['wsl:ubuntu'])
    connector.isReachable.mockResolvedValue(false)
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow(
      'didn’t finish removing'
    )
    expect(connector.connect).not.toHaveBeenCalled()

    // Remove again: a proven stop finishes it.
    await expect(service.remove('wsl:ubuntu')).resolves.toEqual({ stopped: true })
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(removed).toHaveBeenCalledWith('wsl:ubuntu')
  })

  it('keeps a pending stop pending when the stop is unverifiable', async () => {
    const connector = makeConnector([UBUNTU])
    const unverifiable = {
      stopped: false as const,
      reason: 'The terminal daemon did not answer a session count.',
      verdict: 'unverifiable' as const
    }
    connector.stopServer.mockResolvedValue(unverifiable)
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await service.remove('wsl:ubuntu')
    await expect(service.remove('wsl:ubuntu')).resolves.toEqual({ ...unverifiable, kept: true })
    expect(connector.stopServer).toHaveBeenCalledTimes(2)
    expect(listEnvironments(userDataPath)).toHaveLength(1)
  })

  it('finishes a pending Remove on a stopped distro, which proves the stop, without booting it', async () => {
    const connector = makeConnector([UBUNTU])
    connector.stopServer.mockResolvedValueOnce({ stopped: false, reason: 'busy', verdict: 'live' })
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await service.remove('wsl:ubuntu')
    connector.connect.mockClear()
    // What the cold probe answers for a stopped distro.
    connector.stopServer.mockResolvedValueOnce({ stopped: true })

    await expect(service.remove('wsl:ubuntu')).resolves.toEqual({ stopped: true })
    expect(connector.connect).not.toHaveBeenCalled()
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('finishes removing a host whose distro is gone, which runs nothing', async () => {
    const connector = makeConnector([UBUNTU])
    connector.stopServer.mockResolvedValueOnce({ stopped: false, reason: 'busy', verdict: 'live' })
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await service.remove('wsl:ubuntu')
    connector.resolveDistroName.mockResolvedValue(false)

    await expect(service.remove('wsl:ubuntu')).resolves.toEqual({ stopped: true })
    expect(connector.resolveDistroName).toHaveBeenLastCalledWith('Ubuntu', UBUNTU_ID)
    expect(connector.stopServer).toHaveBeenCalledTimes(1)
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('stops, rather than drops, a host whose registry could not be read', async () => {
    const connector = makeConnector([UBUNTU])
    connector.stopServer.mockResolvedValue({ stopped: false, reason: 'busy', verdict: 'live' })
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    connector.resolveDistroName.mockResolvedValue(null)

    await expect(service.remove('wsl:ubuntu')).resolves.toMatchObject({ kept: true })
    expect(listEnvironments(userDataPath)).toHaveLength(1)
  })

  it('stops a renamed distro under its current name, never reading it stopped under the old one', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    connector.resolveDistroName.mockResolvedValue('Ubuntu-Work')

    await service.remove('wsl:ubuntu')
    expect(connector.stopServer).toHaveBeenCalledWith('Ubuntu-Work', 'wsl:ubuntu')
  })

  it('re-adding or connecting a pending host keeps it and withdraws the removal', async () => {
    const connector = makeConnector([UBUNTU])
    connector.stopServer.mockResolvedValue({ stopped: false, reason: 'busy', verdict: 'live' })
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await service.remove('wsl:ubuntu')
    connector.connect.mockClear()

    await expect(service.add({ distro: 'ubuntu' })).resolves.toEqual({
      ok: true,
      environmentId: 'wsl:ubuntu'
    })
    expect(connector.connect).toHaveBeenCalledWith('Ubuntu', {})
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.pendingStop).toBeUndefined()

    await service.remove('wsl:ubuntu')
    // Only the user's own Connect withdraws it; any other caller is refused.
    await expect(service.connect('wsl:ubuntu')).rejects.toThrow('didn’t finish removing')
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.pendingStop).toBeDefined()
    await service.connect('wsl:ubuntu', { withdrawPendingRemoval: true })
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.pendingStop).toBeUndefined()
  })

  it('re-adding a pending host on a stopped distro asks to start it, as any add does', async () => {
    const connector = makeConnector([{ ...UBUNTU, state: 'stopped' }])
    connector.stopServer.mockResolvedValue({ stopped: false, reason: 'busy', verdict: 'live' })
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu', startIfStopped: true })
    await service.remove('wsl:ubuntu')
    connector.connect.mockClear()

    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({
      ok: false,
      kind: 'distro-stopped'
    })
    expect(connector.connect).not.toHaveBeenCalled()
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.pendingStop).toBeDefined()
  })

  it('shows an unfinished removal from launch', async () => {
    const connector = makeConnector([UBUNTU])
    connector.stopServer.mockResolvedValueOnce({ stopped: false, reason: 'busy', verdict: 'live' })
    await makeService(connector).add({ distro: 'Ubuntu' })
    await makeService(connector).remove('wsl:ubuntu')
    published = []
    await makeService(connector).start()
    expect(published).toEqual([
      expect.objectContaining({ state: 'closed', detail: 'busy', removalPending: true })
    ])
  })

  it('does not keep the holder of a host whose Remove is pending', async () => {
    const connector = makeConnector([UBUNTU])
    connector.stopServer.mockResolvedValueOnce({ stopped: false, reason: 'busy', verdict: 'live' })
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await service.remove('wsl:ubuntu')
    await service.start()
    const [isWanted] = connector.adoptHolders.mock.calls[0]
    expect(isWanted('Ubuntu')).toBe(false)
  })

  it('switching to a pending host’s workspace never reconnects it', async () => {
    const connector = makeConnector([UBUNTU])
    connector.stopServer.mockResolvedValueOnce({ stopped: false, reason: 'busy', verdict: 'live' })
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await service.remove('wsl:ubuntu')
    connector.connect.mockClear()

    service.focusHost('wsl:ubuntu')
    await new Promise((resolve) => setImmediate(resolve))
    expect(connector.reachability).not.toHaveBeenCalled()
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('never boots a pending host early at launch', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    rememberWslHostsToWake(userDataPath, ['Ubuntu'])
    // A Remove left pending by a build that still remembered the host.
    setWslHostPendingStop(userDataPath, 'wsl:ubuntu', { since: 1, reason: 'busy', verdict: 'live' })
    const spawn = vi.fn()

    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('forgets the early wake of a host whose Remove ended pending', async () => {
    const connector = makeConnector([UBUNTU])
    connector.stopServer.mockResolvedValueOnce({ stopped: false, reason: 'busy', verdict: 'live' })
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.focusHost('wsl:ubuntu')

    await service.remove('wsl:ubuntu')
    // Withdrawing the removal must not bring the early wake back by itself.
    await service.connect('wsl:ubuntu', { withdrawPendingRemoval: true })
    expect(wakeRememberedWslHosts(userDataPath, vi.fn())).toEqual([])
  })

  it('a due automation never boots a host whose Remove is pending', async () => {
    const connector = makeConnector([UBUNTU])
    connector.stopServer.mockResolvedValueOnce({ stopped: false, reason: 'busy', verdict: 'live' })
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await service.remove('wsl:ubuntu')
    connector.connect.mockClear()
    connector.reachability.mockClear()

    await service.wakeForAutomation('wsl:ubuntu')
    expect(connector.reachability).not.toHaveBeenCalled()
    expect(connector.connect).not.toHaveBeenCalled()
  })
})
