import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  listEnvironments
} from '../../shared/runtime-environment-store'
import { getEnvironmentStorePath } from '../../shared/runtime-environment-store-file'
import { findWslHostDeployment } from '../../shared/runtime-environment-wsl-host-store'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import type { WslHostServerStop, WslHostStatus } from '../../shared/wsl-host-types'
import { OrcadHostUnsupportedError } from '../orcad/orcad-host-unavailable'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import { WslHostService, type WslHostConnector } from './wsl-host-service'
import { wakeRememberedWslHosts } from './wsl-host-early-wake'
import { WslOrcadLaunchDeferredError } from './wsl-orcad-connection-errors'
import type { WslOrcadConnection } from './wsl-orcad-connection'

const KEY = Buffer.alloc(32, 3).toString('base64')
const UBUNTU_ID = '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f'

function pairing(port: number, deviceToken = 'token-1', publicKeyB64 = KEY): string {
  return encodePairingOffer({ v: 2, endpoint: `ws://127.0.0.1:${port}`, deviceToken, publicKeyB64 })
}

function connection(distro: string, port = 42000, token = 'token-1'): WslOrcadConnection {
  return {
    distro,
    environmentId: `wsl:${distro.toLowerCase()}`,
    localPort: port,
    remotePort: 6768,
    fullVersion: '1.0.0+abc',
    pid: 10,
    pairingOffer: pairing(port, token),
    deferredUpdate: null,
    close: async () => {}
  }
}

function makeConnector(distros: WslHostDistroCandidate[]) {
  const active = new Map<string, WslOrcadConnection>()
  // What WSL's running list says about the distro when its server isn't answering.
  const distro: { state: 'running' | 'stopped' | 'unavailable' } = { state: 'running' }
  const connector = {
    listDistros: vi.fn(async () => distros),
    readOrcadPublicKey: vi.fn(async (_distro: string): Promise<string | null> => null),
    connect: vi.fn(async (distro: string) => {
      const opened = connection(distro)
      active.set(distro.toLowerCase(), opened)
      return opened
    }),
    get: vi.fn((distro: string) => active.get(distro.toLowerCase()) ?? null),
    forgetPairingFailures: vi.fn((_environmentId: string) => {}),
    isReachable: vi.fn(async (name: string) => active.has(name.toLowerCase())),
    isSettling: vi.fn((_distro: string) => false),
    reachability: vi.fn(async (name: string, _environmentId: string) =>
      active.has(name.toLowerCase())
        ? ('available' as const)
        : distro.state === 'running'
          ? ('unreachable' as const)
          : distro.state === 'stopped'
            ? ('stopped' as const)
            : ('unavailable' as const)
    ),
    disconnect: vi.fn(async (distro: string) => {
      active.delete(distro.toLowerCase())
    }),
    stopServer: vi.fn(
      async (_distro: string, _environmentId: string): Promise<WslHostServerStop> => ({
        stopped: true
      })
    ),
    releaseHolder: vi.fn(async (_distro: string) => {}),
    adoptHolders: vi.fn(async () => {}),
    dispose: vi.fn(async () => {})
  } satisfies WslHostConnector
  return Object.assign(connector, { distro })
}

const UBUNTU: WslHostDistroCandidate = {
  id: UBUNTU_ID,
  name: 'Ubuntu',
  state: 'running',
  version: 2
}

describe('WslHostService', () => {
  let userDataPath: string
  let published: WslHostStatus[]
  let enabled: boolean
  let serverFiles: boolean
  const pairingChanged = vi.fn()
  const ready = vi.fn()
  const removed = vi.fn()

  function makeService(connector: WslHostConnector): WslHostService {
    const service = new WslHostService({
      userDataPath: () => userDataPath,
      isEnabled: () => enabled,
      hasServerFiles: () => serverFiles,
      publish: (status) => published.push(status),
      pairingChanged,
      ready,
      removed
    })
    service.attach(connector)
    return service
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-host-service-'))
    published = []
    enabled = true
    serverFiles = true
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('adds a running distro: connects, then persists the environment and WSL record', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)

    await expect(service.add({ distro: 'ubuntu' })).resolves.toEqual({
      ok: true,
      environmentId: 'wsl:ubuntu'
    })

    expect(connector.connect).toHaveBeenCalledWith('Ubuntu')
    expect(listEnvironments(userDataPath)).toMatchObject([
      { id: 'wsl:ubuntu', name: 'Ubuntu (WSL)', orcadDeployment: { kind: 'wsl', distro: 'Ubuntu' } }
    ])
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.distroId).toBe(UBUNTU_ID)
    expect(ready).toHaveBeenCalledWith('wsl:ubuntu')
    expect(published.at(-1)).toMatchObject({ environmentId: 'wsl:ubuntu', state: 'ready' })
    await expect(service.listDistros()).resolves.toEqual([
      { name: 'Ubuntu', state: 'running', version: 2, environmentId: 'wsl:ubuntu' }
    ])
  })

  it('adds a distro over a server list a crash left NUL-filled (#18766)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(getEnvironmentStorePath(userDataPath), Buffer.alloc(640))
    const service = makeService(makeConnector([UBUNTU]))

    await expect(service.add({ distro: 'ubuntu' })).resolves.toEqual({
      ok: true,
      environmentId: 'wsl:ubuntu'
    })
    expect(listEnvironments(userDataPath)).toMatchObject([{ id: 'wsl:ubuntu' }])
  })

  it('refuses WSL 1, an added distro, and a stopped distro the user did not ask to start', async () => {
    const connector = makeConnector([
      UBUNTU,
      { id: UBUNTU_ID.replace('0e', '1e'), name: 'Legacy', state: 'running', version: 1 },
      { id: UBUNTU_ID.replace('0e', '2e'), name: 'Debian', state: 'stopped', version: 2 }
    ])
    const service = makeService(connector)

    await expect(service.add({ distro: 'Legacy' })).resolves.toMatchObject({
      ok: false,
      kind: 'unsupported-wsl1',
      message: expect.stringContaining('wsl --set-version Legacy 2')
    })
    await expect(service.add({ distro: 'Debian' })).resolves.toMatchObject({
      ok: false,
      kind: 'distro-stopped'
    })
    await service.add({ distro: 'Ubuntu' })
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({
      ok: false,
      kind: 'already-added'
    })
    expect(connector.connect).toHaveBeenCalledTimes(1)
    expect(connector.readOrcadPublicKey).not.toHaveBeenCalledWith('Debian')

    await expect(service.add({ distro: 'Debian', startIfStopped: true })).resolves.toMatchObject({
      ok: true
    })
  })

  it('refuses a distro whose orcad this desktop already reaches as another server (R25)', async () => {
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'wsl over ssh',
      pairingCode: pairing(41000, 'other-token')
    })
    const connector = makeConnector([UBUNTU])
    connector.readOrcadPublicKey.mockResolvedValue(KEY)
    const service = makeService(connector)

    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({
      ok: false,
      kind: 'ssh-managed',
      message: expect.stringContaining('wsl over ssh')
    })
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('reports a deferred activation and stays off when the experiment is off', async () => {
    const connector = makeConnector([UBUNTU])
    connector.connect.mockRejectedValueOnce(
      new WslOrcadLaunchDeferredError({
        outcome: 'deferred',
        distro: 'Ubuntu',
        candidateVersion: '2.0.0',
        code: 'live-terminals',
        reason: 'Terminals are still running.',
        forceable: true
      })
    )
    const service = makeService(connector)
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({
      ok: false,
      kind: 'deferred',
      message: 'Terminals are still running.'
    })
    expect(listEnvironments(userDataPath)).toEqual([])

    enabled = false
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({ kind: 'disabled' })
  })

  it('persists a relaunch’s new device token from onChange and retires the old transport', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })

    service.handleConnectionChange('Ubuntu', connection('Ubuntu', 42000, 'token-2'), {
      state: 'ready',
      census: null
    })

    const [environment] = listEnvironments(userDataPath)
    expect(getPreferredPairingOffer(environment).deviceToken).toBe('token-2')
    expect(pairingChanged).toHaveBeenCalledWith('wsl:ubuntu')

    service.handleConnectionChange('Ubuntu', null, {
      state: 'distro-stopped',
      terminals: 'exited',
      recovering: false
    })
    expect(published.at(-1)).toMatchObject({ state: 'distro-stopped', detail: null })
  })

  it('shows a deferred update while the incumbent serves, and forwards Force to the connect', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    const deferredUpdate = {
      candidateVersion: '2.0.0+ff',
      code: 'orcad_update_terminals_running',
      reason: '1 terminal is running on this host.',
      forceable: true
    }
    service.handleConnectionChange(
      'Ubuntu',
      { ...connection('Ubuntu'), deferredUpdate },
      { state: 'ready', census: null }
    )
    expect(published.at(-1)).toMatchObject({ state: 'ready', deferredUpdate })
    // A reconnecting host is not serving the incumbent the deferral describes.
    service.handleConnectionChange(
      'Ubuntu',
      { ...connection('Ubuntu'), deferredUpdate },
      {
        state: 'reconnecting',
        reason: 'orcad-exited',
        attempt: 1,
        retryInMs: null,
        terminals: 'unverifiable'
      }
    )
    expect(published.at(-1)).toMatchObject({
      state: 'reconnecting',
      deferredUpdate: null
    })

    await service.connect('wsl:ubuntu', { intent: 'force' })
    expect(connector.connect).toHaveBeenLastCalledWith('Ubuntu', {
      intent: 'force'
    })
    // Explicit Connect must clear standing pairing-repair failures.
    expect(connector.forgetPairingFailures).toHaveBeenLastCalledWith('wsl:ubuntu')
  })

  it('reconciles a retained dead connection for user work without booting for passive calls', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    connector.connect.mockClear()
    // No watch/holder event arrived: the bridge object outlived its server.
    connector.isReachable.mockResolvedValue(false)
    connector.reachability.mockResolvedValue('unreachable')
    expect(connector.get('Ubuntu')).not.toBeNull()

    // Return the WSL-specific disconnected verdict without booting a distro for background calls.
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow(
      'The WSL host Ubuntu isn’t connected.'
    )
    expect(connector.connect).not.toHaveBeenCalled()
    expect(service.hasUserVisibleWork('Ubuntu')).toBe(false)

    service.setVisibleWork(['wsl:ubuntu'])
    expect(service.hasUserVisibleWork('ubuntu')).toBe(true)
    // Reporting visible work connects nothing by itself (E9).
    expect(connector.connect).not.toHaveBeenCalled()

    // Visible work may reconnect to its running distro, on every later server loss.
    await service.ensureForRuntimeCall('wsl:ubuntu')
    await service.ensureForRuntimeCall('wsl:ubuntu')
    expect(connector.connect).toHaveBeenCalledTimes(2)

    service.setVisibleWork([])
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('isn’t connected')
    expect(connector.connect).toHaveBeenCalledTimes(2)
    await service.connect('wsl:ubuntu')
    expect(connector.connect).toHaveBeenCalledTimes(3)
  })

  it('refuses a connect while the experiment is off, but still removes the host', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    connector.connect.mockClear()
    enabled = false
    await service.enabledChanged(false)

    await expect(service.connect('wsl:ubuntu')).rejects.toThrow('turned off in Settings')
    service.setVisibleWork(['wsl:ubuntu'])
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow(
      'turned off in Settings'
    )
    expect(connector.connect).not.toHaveBeenCalled()

    await service.remove('wsl:ubuntu')
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('refuses to add or connect, before any deploy work, when this build lacks the server files', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    connector.connect.mockClear()
    connector.listDistros.mockClear()
    await connector.disconnect('Ubuntu')
    serverFiles = false

    await expect(service.add({ distro: 'Debian' })).resolves.toEqual({
      ok: false,
      kind: 'server-files-missing',
      message: 'This build of Orca can’t run WSL hosts (server files missing).'
    })
    expect(connector.listDistros).not.toHaveBeenCalled()
    await expect(service.connect('wsl:ubuntu')).rejects.toThrow('server files missing')
    service.setVisibleWork(['wsl:ubuntu'])
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('server files missing')
    expect(connector.connect).not.toHaveBeenCalled()
    expect(service.hasServerFiles()).toBe(false)
  })

  it('removes a host: closes its connection, stops its server, releases the holder, drops both records', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })

    await service.remove('wsl:ubuntu')

    expect(connector.disconnect).toHaveBeenCalledWith('Ubuntu')
    expect(connector.stopServer).toHaveBeenCalledWith('Ubuntu', 'wsl:ubuntu')
    expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toBeNull()
    expect(removed).toHaveBeenCalledWith('wsl:ubuntu')
  })

  it('reports what removing left running, and removes the host anyway', async () => {
    const connector = makeConnector([UBUNTU])
    connector.stopServer.mockResolvedValueOnce({
      stopped: false,
      reason: '1 terminal kept running'
    })
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })

    await expect(service.remove('wsl:ubuntu')).resolves.toEqual({
      stopped: false,
      reason: '1 terminal kept running'
    })
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('keeps a host whose removal failed usable and removable again', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    connector.releaseHolder.mockRejectedValueOnce(
      Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    )

    await expect(service.remove('wsl:ubuntu')).rejects.toThrow('EBUSY')

    expect(listEnvironments(userDataPath)).toHaveLength(1)
    expect(removed).not.toHaveBeenCalled()
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).resolves.toBeUndefined()
    await expect(service.connect('wsl:ubuntu')).resolves.toBeUndefined()
    await expect(service.remove('wsl:ubuntu')).resolves.toEqual({ stopped: true })
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(removed).toHaveBeenCalledWith('wsl:ubuntu')
  })

  it('turning the experiment off closes every connection and releases holders; on resumes lazily', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    connector.connect.mockClear()

    enabled = false
    await service.enabledChanged(false)
    expect(connector.disconnect).toHaveBeenCalledWith('Ubuntu')
    expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')
    expect(published.at(-1)).toMatchObject({ environmentId: 'wsl:ubuntu', state: 'closed' })
    // Disabled experiments cannot relaunch for visible work.
    expect(service.hasUserVisibleWork('Ubuntu')).toBe(false)
    service.setVisibleWork(['wsl:ubuntu'])
    expect(connector.connect).not.toHaveBeenCalled()

    enabled = true
    await service.enabledChanged(true)
    // Nothing boots on enable; the window re-reports its focused host, which may.
    expect(connector.connect).not.toHaveBeenCalled()
    expect(service.hasUserVisibleWork('Ubuntu')).toBe(true)
    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledTimes(1))
  })

  it('turning the experiment on with nothing open connects nothing', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    connector.connect.mockClear()
    enabled = false
    await service.enabledChanged(false)
    enabled = true
    await service.enabledChanged(true)
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('keeps a confirmed-stopped host down for polls until the user switches back to it (E9)', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    service.handleConnectionChange('Ubuntu', null, {
      state: 'distro-stopped',
      terminals: 'exited',
      recovering: false
    })
    connector.connect.mockClear()

    // The focused host's polls get a refusal, not a boot, however often they come.
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    service.setVisibleWork(['wsl:ubuntu'])
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    expect(connector.connect).not.toHaveBeenCalled()

    // Switching to one of its workspaces is the user acting on it.
    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledTimes(1))
  })

  it('focus connects without probing WSL while this process has no bridge, but polls still read the running list', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    connector.reachability.mockClear()
    connector.connect.mockClear()

    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledTimes(1))
    expect(connector.reachability).not.toHaveBeenCalled()

    // A poll never takes that shortcut: it reads the running list and refuses a stopped distro.
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    connector.connect.mockClear()
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    expect(connector.reachability).toHaveBeenCalledWith('Ubuntu', 'wsl:ubuntu')
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('focus with a bridge still asks whether the host answers before connecting again', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    connector.reachability.mockClear()
    connector.connect.mockClear()

    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.reachability).toHaveBeenCalledTimes(1))
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('parks a host the moment a poll finds its distro confirmed stopped, never booting it', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    connector.connect.mockClear()
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    // Running again (started some other way) is not enough while parked: still no boot from a poll.
    connector.distro.state = 'running'
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('right after a shutdown, a stale running list cannot make a poll reboot the distro', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    await connector.disconnect('Ubuntu')
    connector.connect.mockClear()
    // The watch just exited and WSL still lists the stopping distro as running.
    connector.distro.state = 'running'
    connector.isSettling.mockReturnValue(true)
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('isn’t connected')
    // Liveness then confirms the stop: the host parks, and polls keep refusing.
    service.handleConnectionChange('Ubuntu', null, {
      state: 'distro-stopped',
      terminals: 'exited',
      recovering: false
    })
    connector.isSettling.mockReturnValue(false)
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('a poll after a focus boot failed does not retry the boot', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    connector.connect.mockClear()
    connector.connect.mockRejectedValueOnce(new Error('boot failed'))
    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledTimes(1))
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    expect(connector.connect).toHaveBeenCalledTimes(1)
  })

  it('never boots for a poll: not visible, or unconfirmed, is a refusal; lost contact never parks', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    connector.connect.mockClear()
    // Not focused: a background poll (forge, worktree list, agent status) gets a refusal.
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('isn’t connected')
    service.setVisibleWork(['wsl:ubuntu'])
    // The running list can't be read: refuse rather than risk a boot, and don't park.
    connector.distro.state = 'unavailable'
    service.handleConnectionChange('Ubuntu', null, {
      state: 'unverifiable',
      reason: 'running-list-unavailable',
      terminals: 'unverifiable'
    })
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('isn’t connected')
    expect(connector.connect).not.toHaveBeenCalled()
    connector.distro.state = 'running'
    await service.ensureForRuntimeCall('wsl:ubuntu')
    expect(connector.connect).toHaveBeenCalledTimes(1)
    // Even this reconnect to a running distro may not boot it if it stops meanwhile.
    expect(connector.connect).toHaveBeenCalledWith('Ubuntu', { noBoot: true })
  })

  it('lifts a park on an explicit Connect', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    await connector.disconnect('Ubuntu')
    service.handleConnectionChange('Ubuntu', null, {
      state: 'distro-stopped',
      terminals: 'exited',
      recovering: false
    })
    await service.connect('wsl:ubuntu')
    await connector.disconnect('Ubuntu')
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).resolves.toBeUndefined()
  })

  it('stops tracking a host before stopping its server, and never starts anything for it after', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    connector.connect.mockClear()
    let duringStop: { visible: boolean; known: boolean; connect: string } | null = null
    connector.stopServer.mockImplementationOnce(async () => {
      // The renderer still reports the open project, and a call arrives with the bridge closed.
      await connector.disconnect('Ubuntu')
      service.setVisibleWork(['wsl:ubuntu'])
      duringStop = {
        visible: service.hasUserVisibleWork('Ubuntu'),
        known: service.isKnownDistro('Ubuntu'),
        connect: await service.ensureForRuntimeCall('wsl:ubuntu').then(
          () => 'connected',
          (error: Error) => error.message
        )
      }
      return { stopped: true }
    })

    await service.remove('wsl:ubuntu')

    expect(duringStop).toEqual({
      visible: false,
      known: true,
      connect: 'This WSL host is being removed.'
    })
    expect(connector.connect).not.toHaveBeenCalled()
    expect(service.isKnownDistro('Ubuntu')).toBe(false)
    service.setVisibleWork(['wsl:ubuntu'])
    await service.ensureForRuntimeCall('wsl:ubuntu')
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('releases the holder of a failed or deferred first add, which no record would ever find', async () => {
    const connector = makeConnector([UBUNTU])
    connector.connect.mockRejectedValueOnce(new Error('deploy failed'))
    const service = makeService(connector)
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({ kind: 'failed' })
    expect(connector.disconnect).toHaveBeenCalledWith('Ubuntu')
    expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')

    vi.clearAllMocks()
    connector.connect.mockRejectedValueOnce(
      new WslOrcadLaunchDeferredError({
        outcome: 'deferred',
        distro: 'Ubuntu',
        candidateVersion: '2.0.0',
        code: 'live-terminals',
        reason: 'Terminals are still running.',
        forceable: true
      })
    )
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({ kind: 'deferred' })
    expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('an add the experiment was turned off during ends without a host, connection or holder', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    let finishConnect: () => void = () => {}
    connector.connect.mockImplementationOnce(async (distro: string) => {
      await new Promise<void>((resolve) => {
        finishConnect = resolve
      })
      return connection(distro)
    })
    const adding = service.add({ distro: 'Ubuntu' })
    await vi.waitFor(() => expect(connector.connect).toHaveBeenCalled())

    // Off and back on before the connect lands: the add started under the old setting.
    enabled = false
    await service.enabledChanged(false)
    enabled = true
    await service.enabledChanged(true)
    finishConnect()

    await expect(adding).resolves.toMatchObject({ ok: false, kind: 'disabled' })
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(connector.disconnect).toHaveBeenCalledWith('Ubuntu')
    expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')
    expect(ready).not.toHaveBeenCalled()
  })

  it('treats a distro being added as known, so its first connect may spawn', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    let knownWhileAdding = false
    connector.connect.mockImplementationOnce(async (distro: string) => {
      knownWhileAdding = service.isKnownDistro(distro)
      return connection(distro)
    })
    await service.add({ distro: 'Ubuntu' })
    expect(knownWhileAdding).toBe(true)
  })

  it('remembers only the focused host for an early boot next launch (E9)', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    const spawn = vi.fn()
    // Open work alone is not remembered.
    service.setVisibleWork(['wsl:ubuntu'])
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    service.focusHost('wsl:ubuntu')
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual(['Ubuntu'])
    service.focusHost(null)
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    service.focusHost('wsl:ubuntu')
    enabled = false
    await service.enabledChanged(false)
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('forgets the early-wake host when it is removed', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.focusHost('wsl:ubuntu')
    await service.remove('wsl:ubuntu')
    // Re-registering the distro must not bring the old early wake back.
    await service.add({ distro: 'Ubuntu' })
    expect(wakeRememberedWslHosts(userDataPath, vi.fn())).toEqual([])
  })

  it('adopts holders at startup only when a WSL host exists', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.start()
    expect(connector.adoptHolders).not.toHaveBeenCalled()

    await service.add({ distro: 'Ubuntu' })
    await service.start()
    expect(connector.adoptHolders).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'unsupported-wsl1',
      () => new OrcadHostUnsupportedError('WSL 1 cannot run the Orca server.'),
      'WSL 1 cannot run the Orca server.'
    ],
    ['failed', () => new Error('bridge refused'), 'bridge refused']
  ])(
    'reports a %s connect, releases it, and persists nothing',
    async (kind, makeError, message) => {
      const connector = makeConnector([UBUNTU])
      connector.connect.mockRejectedValueOnce(makeError())
      const service = makeService(connector)
      await expect(service.add({ distro: 'Ubuntu' })).resolves.toEqual({ ok: false, kind, message })
      expect(listEnvironments(userDataPath)).toEqual([])
      // Unpersisted Adds own cleanup; later service operations cannot find their connection/holder.
      expect(connector.disconnect).toHaveBeenCalledExactlyOnceWith('Ubuntu')
      expect(connector.releaseHolder).toHaveBeenCalledExactlyOnceWith('Ubuntu')
      expect(ready).not.toHaveBeenCalled()
      expect(published).toEqual([])
    }
  )

  it('undoes the connection when the host cannot be saved, even if the disconnect fails', async () => {
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'Ubuntu (WSL)',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://203.0.113.9:6768',
        deviceToken: 'other',
        publicKeyB64: Buffer.alloc(32, 9).toString('base64')
      })
    })
    const connector = makeConnector([UBUNTU])
    const order: string[] = []
    connector.disconnect.mockImplementationOnce(async () => {
      order.push('disconnect')
      throw new Error('already gone')
    })
    connector.releaseHolder.mockImplementationOnce(async () => {
      order.push('release')
      throw new Error('holder gone too')
    })
    const service = makeService(connector)
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toEqual({
      ok: false,
      kind: 'failed',
      message: 'A server named "Ubuntu (WSL)" already exists.'
    })
    expect(order).toEqual(['disconnect', 'release'])
    expect(connector.disconnect).toHaveBeenCalledWith('Ubuntu')
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toBeNull()
    expect(ready).not.toHaveBeenCalled()
  })

  it('shares one add between concurrent requests for the same distro, by any casing', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    const first = service.add({ distro: 'Ubuntu' })
    const second = service.add({ distro: ' ubuntu ' })
    expect(second).toBe(first)
    await expect(first).resolves.toEqual({ ok: true, environmentId: 'wsl:ubuntu' })
    expect(connector.listDistros).toHaveBeenCalledTimes(1)
    expect(connector.connect).toHaveBeenCalledTimes(1)
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({ ok: false })
    expect(connector.listDistros).toHaveBeenCalledTimes(2)
  })

  it('checks admission, then shared orcad, then connects; publishes ready before announcing it', async () => {
    const connector = makeConnector([UBUNTU])
    const order: string[] = []
    connector.listDistros.mockImplementation(async () => {
      order.push('list')
      return [UBUNTU]
    })
    connector.readOrcadPublicKey.mockImplementation(async (distro: string) => {
      order.push(`key:${distro}`)
      return null
    })
    // A new-connection deferral proves status was republished from that connection.
    const deferredUpdate = {
      candidateVersion: '2.0.0+ff',
      code: 'orcad_update_terminals_running',
      reason: '1 terminal is running on this host.',
      forceable: true
    }
    connector.connect.mockImplementation(async (distro: string) => {
      order.push(`connect:${distro}`)
      return { ...connection(distro), deferredUpdate }
    })
    ready.mockImplementation((id: string) => order.push(`ready:${id}:${published.length}`))
    const service = makeService(connector)
    await service.add({ distro: 'UBUNTU' })
    expect(order).toEqual(['list', 'key:Ubuntu', 'connect:Ubuntu', 'ready:wsl:ubuntu:1'])
    expect(published).toEqual([
      {
        environmentId: 'wsl:ubuntu',
        distro: 'Ubuntu',
        state: 'ready',
        detail: null,
        deferredUpdate
      }
    ])
  })

  it('refuses an add with no WSL connector before touching one, while turned off', async () => {
    enabled = false
    const service = new WslHostService({
      userDataPath: () => userDataPath,
      isEnabled: () => enabled,
      hasServerFiles: () => serverFiles,
      publish: (status) => published.push(status),
      pairingChanged,
      ready,
      removed
    })
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({ ok: false })
    enabled = true
    await expect(service.add({ distro: 'Ubuntu' })).rejects.toThrow(
      'WSL hosts are not available on this computer.'
    )
  })
})
