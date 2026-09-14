import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { makeDeferred } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  registerPtyHandlers,
  registerSshPtyProvider,
  setLocalPtyProvider,
  rebindLocalProviderListeners,
  getLocalPtyProvider
} from './pty'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, installDaemonTestProvider, installObservableDaemonTestProvider } =
    setupPtyIpcSuite()

  // Why: the cap/flag must never fire in the common case (renderer keeps up), so small output carries no droppedBacklog.
  it('does not flag droppedBacklog for ordinary small output under the cap', async () => {
    vi.useFakeTimers()
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn(() => 12),
      createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-small'),
      registerPreAllocatedHandleForPty: vi.fn()
    }
    try {
      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        undefined,
        undefined,
        { awaitLocalPtyStartup: () => Promise.resolve() }
      )
      const pendingSpawn = handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        sessionId: 'small-output-session'
      }) as Promise<{ id: string }>
      await Promise.resolve()
      const daemon = installObservableDaemonTestProvider()
      rebindLocalProviderListeners()
      const result = await pendingSpawn

      daemon.emitData(result.id, 'small output')
      await vi.advanceTimersByTimeAsync(50)

      const dataSends = mainWindow.webContents.send.mock.calls.filter(
        (call) => call[0] === 'pty:data' && (call[1] as { id: string }).id === result.id
      )
      expect(dataSends.length).toBeGreaterThan(0)
      for (const call of dataSends) {
        expect((call[1] as { droppedBacklog?: boolean }).droppedBacklog).toBeUndefined()
      }
    } finally {
      vi.useRealTimers()
    }
  })
  it('waits for the desktop startup barrier before runtime local spawns resolve the provider', async () => {
    const barrier = makeDeferred()
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        awaitLocalPtyStartup: () => barrier.promise
      }
    )
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      spawn: (args: { cols: number; rows: number; env?: Record<string, string> }) => Promise<{
        id: string
      }>
    }

    const pendingSpawn = controller.spawn({ cols: 80, rows: 24, env: {} })

    await Promise.resolve()
    expect(spawnMock).not.toHaveBeenCalled()

    const daemonSpawn = installDaemonTestProvider()
    barrier.resolve()
    const result = await pendingSpawn

    expect(daemonSpawn).toHaveBeenCalledTimes(1)
    expect(result.id).toBe(daemonSpawn.mock.calls[0]?.[0].sessionId)
    expect(spawnMock).not.toHaveBeenCalled()
  })
  it('does not wait on the desktop startup barrier for SSH spawns or kills', async () => {
    const barrier = makeDeferred()
    const awaitLocalPtyStartup = vi.fn(() => barrier.promise)
    const sshSpawn = vi.fn(async () => ({ id: 'remote-pty' }))
    const sshShutdown = vi.fn()
    registerSshPtyProvider('ssh-1', {
      spawn: sshSpawn,
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: sshShutdown,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { awaitLocalPtyStartup }
    )

    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        connectionId: 'ssh-1',
        env: {}
      })
    ).resolves.toEqual(expect.objectContaining({ id: 'remote-pty' }))
    await handlers.get('pty:kill')!(null, { id: 'remote-pty' })

    expect(awaitLocalPtyStartup).not.toHaveBeenCalled()
    expect(sshSpawn).toHaveBeenCalledTimes(1)
    expect(sshShutdown).toHaveBeenCalledWith('remote-pty', {
      immediate: true,
      keepHistory: false
    })
  })
  it('lists sessions from both local and SSH providers', async () => {
    registerPtyHandlers(mainWindow as never)
    const sshListProcesses = vi.fn(async () => [
      { id: 'remote-pty', cwd: '/remote', title: 'ssh-shell' }
    ])
    const sshShutdown = vi.fn(async () => undefined)
    registerSshPtyProvider('ssh-1', {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: sshShutdown,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: sshListProcesses,
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })
    const sessions = (await handlers.get('pty:listSessions')!(null, undefined)) as {
      id: string
      cwd: string
      title: string
    }[]

    expect(sshListProcesses).toHaveBeenCalled()
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cwd: '/remote', id: 'remote-pty', title: 'ssh-shell' })
      ])
    )

    await handlers.get('pty:kill')!(null, { id: 'remote-pty' })
    expect(sshShutdown).toHaveBeenCalledWith('remote-pty', {
      immediate: true,
      keepHistory: false
    })
  })
  it('starts local and SSH session inventories concurrently', async () => {
    let resolveLocal!: (sessions: { id: string; cwd: string; title: string }[]) => void
    const localSessions = new Promise<{ id: string; cwd: string; title: string }[]>((resolve) => {
      resolveLocal = resolve
    })
    vi.spyOn(getLocalPtyProvider(), 'listProcesses').mockReturnValue(localSessions)
    registerPtyHandlers(mainWindow as never)

    let resolveSsh!: (sessions: { id: string; cwd: string; title: string }[]) => void
    const sshSessions = new Promise<{ id: string; cwd: string; title: string }[]>((resolve) => {
      resolveSsh = resolve
    })
    const sshListProcesses = vi.fn(() => sshSessions)
    registerSshPtyProvider('ssh-1', {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: sshListProcesses,
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    const pendingInventory = handlers.get('pty:listSessions')!(null, undefined)

    expect(sshListProcesses).toHaveBeenCalledTimes(1)
    resolveLocal([])
    resolveSsh([])
    await pendingInventory
  })
  it('reports authoritative snapshot capability with the owning provider context', async () => {
    const capabilityProvider = {
      authoritativeIds: new Set(['current-pty']),
      canProvideAuthoritativeBufferSnapshot(id: string) {
        return this.authoritativeIds.has(id)
      }
    }
    registerPtyHandlers(mainWindow as never)
    setLocalPtyProvider(capabilityProvider as never)
    const result = await handlers.get('pty:getAuthoritativeBufferSnapshotCapabilities')?.(null, {
      ids: ['current-pty', 'legacy-pty', 'current-pty', 42]
    })

    expect(result).toEqual([
      { id: 'current-pty', authoritative: true },
      { id: 'legacy-pty', authoritative: false }
    ])
  })
  it('waits for local provider startup before resolving snapshot capability', async () => {
    const barrier = makeDeferred()
    const awaitLocalPtyProviderStartup = vi.fn(() => barrier.promise)
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { awaitLocalPtyProviderStartup }
    )
    const pending = Promise.resolve(
      handlers.get('pty:getAuthoritativeBufferSnapshotCapabilities')?.(null, {
        ids: ['restored-local-pty']
      })
    )
    let settled = false
    void pending.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(awaitLocalPtyProviderStartup).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)

    installDaemonTestProvider({ canProvideAuthoritativeBufferSnapshot: () => true })
    barrier.resolve()

    await expect(pending).resolves.toEqual([{ id: 'restored-local-pty', authoritative: true }])
  })
  it('does not gate remote snapshot capability on local provider startup', async () => {
    const awaitLocalPtyProviderStartup = vi.fn(() => new Promise<void>(() => {}))
    registerSshPtyProvider('ssh-1', {
      canProvideAuthoritativeBufferSnapshot: () => false
    } as never)
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { awaitLocalPtyProviderStartup }
    )

    const result = await handlers.get('pty:getAuthoritativeBufferSnapshotCapabilities')?.(null, {
      ids: ['remote:environment@@pty-1', 'ssh:ssh-1@@pty-2']
    })

    expect(awaitLocalPtyProviderStartup).not.toHaveBeenCalled()
    expect(result).toEqual([
      { id: 'remote:environment@@pty-1', authoritative: false },
      { id: 'ssh:ssh-1@@pty-2', authoritative: false }
    ])
  })
  it('answers false, not null, for a resolved provider with no snapshot capability', async () => {
    // Null is never cached, so missing optional methods must resolve false.
    registerPtyHandlers(mainWindow as never)
    setLocalPtyProvider({ spawn: vi.fn(), write: vi.fn() } as never)

    const result = await handlers.get('pty:getAuthoritativeBufferSnapshotCapabilities')?.(null, {
      ids: ['local-pty']
    })

    expect(result).toEqual([{ id: 'local-pty', authoritative: false }])
  })
  it('checks single-PTY liveness without listing every session', async () => {
    const hasPty = vi.fn((id: string) => id === 'live-pty')
    const listProcesses = vi.fn(async () => {
      throw new Error('listProcesses should not be called')
    })
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses,
      attach: vi.fn(),
      hasPty,
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    registerPtyHandlers(mainWindow as never)

    await expect(handlers.get('pty:hasPty')!(null, { id: 'live-pty' })).resolves.toBe(true)
    await expect(handlers.get('pty:hasPty')!(null, { id: 'dead-pty' })).resolves.toBe(false)

    expect(hasPty).toHaveBeenCalledWith('live-pty')
    expect(hasPty).toHaveBeenCalledWith('dead-pty')
    expect(listProcesses).not.toHaveBeenCalled()
  })
  it('treats unsupported or failed single-PTY liveness as unknown', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    registerPtyHandlers(mainWindow as never)

    await expect(handlers.get('pty:hasPty')!(null, { id: 'maybe-pty' })).resolves.toBe(null)

    const hasPty = vi.fn(() => {
      throw new Error('provider unavailable')
    })
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      hasPty,
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    await expect(handlers.get('pty:hasPty')!(null, { id: 'maybe-pty' })).resolves.toBe(null)
  })
})
