import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../providers/types'

const {
  checkDaemonHealthMock,
  ensureRunningOverrides,
  adapterInstances,
  unbindLocalProviderListenersMock,
  rebindLocalProviderListenersMock,
  importFresh,
  installDefaultNetConnectStub,
  moduleFactories
} = await vi.hoisted(async () =>
  (await import('./daemon-init-test-harness')).createDaemonInitMocks()
)

vi.mock('fs', () => moduleFactories.fs())
vi.mock('child_process', async (importOriginal) =>
  moduleFactories.childProcess(await importOriginal<Record<string, unknown>>())
)
vi.mock('net', () => moduleFactories.net())
vi.mock('./daemon-health', () => moduleFactories.daemonHealth())
vi.mock('./daemon-pid-identity', () => moduleFactories.daemonPidIdentity())
vi.mock('./daemon-tcc-attribution', () => moduleFactories.daemonTccAttribution())
vi.mock('./daemon-bundle-staleness', () => moduleFactories.daemonBundleStaleness())
vi.mock('./daemon-stale-kill', () => moduleFactories.daemonStaleKill())
vi.mock('./daemon-process-start-time', () => moduleFactories.daemonProcessStartTime())
vi.mock('./daemon-pid-file-parse', () => moduleFactories.daemonPidFileParse())
vi.mock('./client', () => moduleFactories.client())
vi.mock('./daemon-lifecycle-event', () => moduleFactories.daemonLifecycleEvent())
vi.mock('./daemon-spawner', () => moduleFactories.daemonSpawner())
vi.mock('./daemon-pty-adapter', () => moduleFactories.daemonPtyAdapter())
vi.mock('../ipc/pty', () => moduleFactories.ipcPty())

describe('restart provider continuity', () => {
  beforeEach(() => installDefaultNetConnectStub())
  afterEach(() => vi.clearAllMocks())

  it('delivers existing guest output and exit while local replacement is unresolved', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const { bindProviderListeners } = await import('../ipc/pty/provider/bind-listeners')
    const lifecycle = await import('../ipc/pty/provider/listener-lifecycle')
    const { registerWslPtyProvider } = await import('../ipc/pty/provider/registry')
    const { createUnavailablePtyProvider } = await import('../providers/unavailable-pty-provider')
    const dataListeners = new Set<Parameters<IPtyProvider['onData']>[0]>()
    const exitListeners = new Set<Parameters<IPtyProvider['onExit']>[0]>()
    const release = registerWslPtyProvider(
      { distro: 'Ubuntu', relayBuildId: 'continuity' },
      {
        ...createUnavailablePtyProvider(),
        onData: (listener) => {
          dataListeners.add(listener)
          return () => {
            dataListeners.delete(listener)
          }
        },
        onExit: (listener) => {
          exitListeners.add(listener)
          return () => {
            exitListeners.delete(listener)
          }
        }
      }
    )
    const session = {
      acceptPtyDataForRenderer: vi.fn(),
      sendModelRestoreNeededMarker: vi.fn(),
      consumeSyntheticKillExit: vi.fn(),
      sendPtyExitToRenderer: vi.fn()
    }
    bindProviderListeners(session)
    unbindLocalProviderListenersMock.mockImplementation(lifecycle.unbindLocalProviderListeners)
    rebindLocalProviderListenersMock.mockImplementation(() => bindProviderListeners(session))
    let finish!: () => void
    ensureRunningOverrides.push(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { socketPath: '/fake/replacement', tokenPath: '/fake/token' }
    })
    const restarting = mod.restartDaemon()
    try {
      await vi.waitFor(() => expect(finish).toBeDefined())
      dataListeners.forEach((listener) => listener({ id: 'guest', data: 'during restart' }))
      exitListeners.forEach((listener) => listener({ id: 'guest', code: 7 }))
      expect(session.acceptPtyDataForRenderer).toHaveBeenCalledWith(
        { id: 'guest', data: 'during restart' },
        undefined
      )
      expect(session.sendPtyExitToRenderer).toHaveBeenCalledWith({ id: 'guest', code: 7 })
      expect(unbindLocalProviderListenersMock).not.toHaveBeenCalled()
    } finally {
      finish?.()
      await restarting
      release()
      lifecycle.unbindLocalProviderListeners()
    }
  })

  it('retries initialization after startup failed without installing a provider', async () => {
    const mod = await importFresh()
    ensureRunningOverrides.push(async () => {
      throw new Error('startup unavailable')
    })
    await expect(mod.initDaemonPtyProvider()).rejects.toThrow('startup unavailable')
    expect(mod.getDaemonProvider()).toBeNull()
    await expect(mod.restartDaemon()).resolves.toEqual({ killedCount: 0 })
    expect(mod.getDaemonProvider()).not.toBeNull()
  })

  it.each([false, true])(
    're-arms admission on automatic respawn (restarted=%s)',
    async (restarted) => {
      const mod = await importFresh()
      await mod.initDaemonPtyProvider()
      if (restarted) {
        await mod.restartDaemon()
      }
      const adapter = adapterInstances.at(-1)!
      ensureRunningOverrides.push(async () => ({
        socketPath: '/fake/degraded-respawn',
        tokenPath: '/fake/token',
        mode: 'fresh-spawns-unavailable'
      }))
      checkDaemonHealthMock.mockResolvedValue('unhealthy')
      await adapter.options.respawn?.('daemon_died')
      expect(adapter.options.freshSpawnAdmission?.unavailable).toBe(true)
      await expect(mod.retryDaemonPtyProvider()).rejects.toThrow('still unable')
      checkDaemonHealthMock.mockResolvedValue('healthy')
      await mod.retryDaemonPtyProvider()
      expect(adapter.options.freshSpawnAdmission?.unavailable).toBe(false)
    }
  )

  it('keeps replacement degraded mode attachable while rejecting fresh spawn', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    ensureRunningOverrides.push(async () => ({
      socketPath: '/fake/degraded',
      tokenPath: '/fake/token',
      mode: 'fresh-spawns-unavailable'
    }))
    checkDaemonHealthMock.mockResolvedValue('unhealthy')
    await mod.restartDaemon()
    const { DaemonPtyRouter } = await import('./daemon-pty-router')
    const provider = mod.getDaemonProvider()
    if (!(provider instanceof DaemonPtyRouter)) {
      throw new Error('Expected degraded router')
    }
    expect(provider.freshSpawnsUnavailable).toBe(true)
    await expect(provider.spawn({ cols: 80, rows: 24 })).rejects.toThrow(
      'Terminal service unavailable'
    )
    const adapter = provider.getCurrentAdapter()
    const attach = vi.fn(async () => {})
    Object.assign(adapter, { attach })
    adapterInstances[1].listProcesses.mockResolvedValue([
      { id: 'retained', cwd: '/repo', title: 'shell' }
    ])
    await provider.discoverLegacySessions()
    await provider.attach('retained')
    expect(attach).toHaveBeenCalledWith('retained')
  })
})
