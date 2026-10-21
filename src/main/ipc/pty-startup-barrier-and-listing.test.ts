import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { makeDeferred } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty/register-handlers'
import { setLocalPtyProvider } from './pty/provider/registry'
import { rebindLocalProviderListeners } from './pty/provider/listener-lifecycle'

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
    // A session that survived a restart is live on the host before this run attaches it.
    const probePtyLiveness = vi.fn(async (id: string) => id === 'restored-pty')
    const listProcesses = vi.fn(async () => {
      throw new Error('listProcesses should not be called')
    })
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      writeWithSettlement: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      resetInputModes: vi.fn(),
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
      probePtyLiveness,
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    })
    registerPtyHandlers(mainWindow as never)

    await expect(handlers.get('pty:hasPty')!(null, { id: 'live-pty' })).resolves.toBe(true)
    await expect(handlers.get('pty:hasPty')!(null, { id: 'restored-pty' })).resolves.toBe(true)
    await expect(handlers.get('pty:hasPty')!(null, { id: 'dead-pty' })).resolves.toBe(false)

    expect(hasPty).toHaveBeenCalledWith('live-pty')
    expect(hasPty).toHaveBeenCalledWith('dead-pty')
    expect(probePtyLiveness).not.toHaveBeenCalledWith('live-pty')
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
