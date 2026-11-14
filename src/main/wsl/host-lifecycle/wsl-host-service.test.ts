import '../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listEnvironments } from '../../../shared/remote-runtime/host-store/runtime-environment-store'

import type { WslHostStatus } from '../../../shared/wsl-host-types'

import { WslHostService } from './wsl-host-service'
import type { WslHostConnector } from './wsl-host-connector-contract'

import { UBUNTU, connection, makeConnector } from './__tests__/wsl-host-service-test-connector'

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

  it('shares concurrent Add through one owned registration', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    const [first, second] = await Promise.all([
      service.add({ distro: 'Ubuntu' }),
      service.add({ distro: 'Ubuntu' })
    ])
    expect(first).toEqual(second)
    expect(await listEnvironments(userDataPath)).toHaveLength(1)
    expect(await service.ensureForRuntimeCall('wsl:ubuntu')).toBeUndefined()
    expect(connector.disconnect).not.toHaveBeenCalled()
  })

  it('a closed connection supersedes Ready while its registry read is pending', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    ready.mockClear()
    const first = service.handleConnectionChange('Ubuntu', connection('Ubuntu', 42001), {
      state: 'ready',
      census: null
    })
    const closed = service.handleConnectionChange('Ubuntu', null, { state: 'closed' })
    await Promise.all([first, closed])
    expect(service.getStatuses()).toEqual([
      expect.objectContaining({ environmentId: 'wsl:ubuntu', state: 'closed' })
    ])
    expect(ready).not.toHaveBeenCalled()
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

    expect(await listEnvironments(userDataPath)).toHaveLength(1)
    expect(removed).not.toHaveBeenCalled()
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).resolves.toBeUndefined()
    await expect(service.connect('wsl:ubuntu')).resolves.toBeUndefined()
    await expect(service.remove('wsl:ubuntu')).resolves.toEqual({ stopped: true })
    expect(await listEnvironments(userDataPath)).toEqual([])
    expect(removed).toHaveBeenCalledWith('wsl:ubuntu')
  })

  it('a focus re-check overtaken by a user Start never publishes stopped over the live host', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    let finishRead: (state: 'stopped') => void = () => {}
    connector.reachability.mockImplementationOnce(
      () => new Promise((resolve) => (finishRead = resolve))
    )

    await service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.reachability).toHaveBeenCalled())
    // The user's Start boots and connects while the focus read is still out.
    connector.distro.state = 'running'
    await service.connect('wsl:ubuntu')
    await service.handleConnectionChange('Ubuntu', connection('Ubuntu'), {
      state: 'ready',
      census: null
    })
    finishRead('stopped')

    await vi.waitFor(() => expect(connector.reachability).toHaveBeenCalledTimes(2))
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).resolves.toBeUndefined()
    expect(published.at(-1)).toMatchObject({ environmentId: 'wsl:ubuntu', state: 'ready' })
    expect(published.filter((status) => status.state === 'distro-stopped')).toEqual([])
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
        visible: await service.hasUserVisibleWork('Ubuntu'),
        known: await service.isKnownDistro('Ubuntu'),
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
    expect(await service.isKnownDistro('Ubuntu')).toBe(false)
    service.setVisibleWork(['wsl:ubuntu'])
    await service.ensureForRuntimeCall('wsl:ubuntu')
    expect(connector.connect).not.toHaveBeenCalled()
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
    expect(await listEnvironments(userDataPath)).toEqual([])
    expect(connector.disconnect).toHaveBeenCalledWith('Ubuntu')
    expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')
    expect(ready).not.toHaveBeenCalled()
  })
})
