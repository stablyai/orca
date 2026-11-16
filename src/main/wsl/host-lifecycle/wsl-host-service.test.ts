import '../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listEnvironments } from '../../../shared/remote-runtime/host-store/runtime-environment-store'

import type { WslHostStatus } from '../../../shared/remote-runtime/wsl-hosts/wsl-host-types'

import { WslHostService } from './wsl-host-service'
import type { WslHostConnector } from './wsl-host-connector-contract'
import * as connectionRecords from './wsl-host-connection-record'

import { UBUNTU, connection, makeConnector } from './__tests__/wsl-host-service-test-connector'

describe('WslHostService', () => {
  let userDataPath: string
  let published: WslHostStatus[]
  let enabled: boolean
  let serverFiles: boolean
  const pairingChanged = vi.fn()
  const ready = vi.fn()
  const removed = vi.fn()

  function makeService(
    connector: WslHostConnector,
    onRunning: (task: () => unknown) => void = () => {}
  ): WslHostService {
    const service = new WslHostService({
      userDataPath: () => userDataPath,
      isEnabled: () => enabled,
      hasServerFiles: () => serverFiles,
      publish: (status) => published.push(status),
      pairingChanged,
      ready,
      removed,
      deferUntilRunning: (_distro, _key, task) => onRunning(task)
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

  it('a confirmed runtime stop remains visible after an older connection notice finishes', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    const records = await connectionRecords.readWslHostRecordsQuietly(userDataPath)
    const registryRead = Promise.withResolvers<typeof records>()
    let closed: Promise<void> = Promise.resolve()
    connector.reachability.mockImplementationOnce(async () => {
      vi.spyOn(connectionRecords, 'readWslHostRecordsQuietly').mockImplementationOnce(
        () => registryRead.promise
      )
      closed = service.handleConnectionChange('Ubuntu', null, { state: 'closed' })
      return 'stopped'
    })
    try {
      await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow()
    } finally {
      registryRead.resolve(records)
      await closed
    }
    expect(service.getStatuses()).toEqual([
      expect.objectContaining({ environmentId: 'wsl:ubuntu', state: 'distro-stopped' })
    ])
  })

  it('deferred recovery preserves the replacement connection pairing and Ready notification', async () => {
    const connector = makeConnector([UBUNTU])
    let resume: () => unknown = () => {}
    const service = makeService(connector, (task) => (resume = task))
    await service.add({ distro: 'Ubuntu' })
    connector.reachability.mockResolvedValueOnce('stopped')
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow()
    ready.mockClear()
    const started = Promise.withResolvers<void>()
    const reachability = Promise.withResolvers<'available'>()
    connector.reachability.mockImplementationOnce(() => {
      started.resolve()
      return reachability.promise
    })
    resume()
    await started.promise
    const records = await connectionRecords.readWslHostRecordsQuietly(userDataPath)
    const registryRead = Promise.withResolvers<typeof records>()
    vi.spyOn(connectionRecords, 'readWslHostRecordsQuietly').mockImplementationOnce(
      () => registryRead.promise
    )
    const replacement = connection('Ubuntu', 42001, 'replacement')
    connector.get.mockReturnValue(replacement)
    const changed = service.handleConnectionChange('Ubuntu', replacement, {
      state: 'ready',
      census: null
    })
    const recoveryPublished = Promise.withResolvers<void>()
    const unsubscribe = service.onStatusesChanged(() => {
      if (service.getStatuses().some((status) => status.state === 'ready')) {
        recoveryPublished.resolve()
      }
    })
    try {
      reachability.resolve('available')
      await recoveryPublished.promise
    } finally {
      unsubscribe()
      registryRead.resolve(records)
      await changed
    }
    expect(ready).toHaveBeenCalledWith('wsl:ubuntu', 'Ubuntu')
    expect((await connectionRecords.readWslHostRecordsQuietly(userDataPath))[0]?.localPort).toBe(
      42001
    )
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

  it.each([
    { reachability: 'available', parked: false, outcome: 'connected', state: 'ready' },
    { reachability: 'stopped', parked: false, outcome: 'refused', state: 'distro-stopped' },
    { reachability: 'stopped', parked: true, outcome: 'refused', state: 'distro-stopped' }
  ] as const)(
    'a pending Ready follows the fresh probe verdict ($reachability, parked=$parked)',
    async (expected) => {
      const connector = makeConnector([UBUNTU])
      const service = makeService(connector)
      await service.add({ distro: 'Ubuntu' })
      if (expected.parked) {
        connector.reachability.mockResolvedValueOnce('stopped')
        await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow()
      }
      await connector.disconnect('Ubuntu')
      connector.distro.state = 'stopped'
      const probeStarted = Promise.withResolvers<void>()
      const probe = Promise.withResolvers<'stopped'>()
      connector.reachability.mockImplementationOnce(() => {
        probeStarted.resolve()
        return probe.promise
      })
      const runtimeCall = service.ensureForRuntimeCall('wsl:ubuntu').then(
        () => 'connected',
        () => 'refused'
      )
      await probeStarted.promise
      connector.distro.state = 'running'
      const opened = await connector.connect('Ubuntu')
      const records = await connectionRecords.readWslHostRecordsQuietly(userDataPath)
      const registryRead = Promise.withResolvers<typeof records>()
      vi.spyOn(connectionRecords, 'readWslHostRecordsQuietly').mockImplementationOnce(
        () => registryRead.promise
      )
      const readyChange = service.handleConnectionChange('Ubuntu', opened, {
        state: 'ready',
        census: null
      })
      connector.reachability.mockResolvedValueOnce(expected.reachability)
      let outcome: string
      try {
        probe.resolve('stopped')
        outcome = await runtimeCall
      } finally {
        registryRead.resolve(records)
        await readyChange
      }
      expect(outcome).toBe(expected.outcome)
      expect(service.getStatuses()).toEqual([
        expect.objectContaining({ environmentId: 'wsl:ubuntu', state: expected.state })
      ])
    }
  )

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
