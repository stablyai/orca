import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { makeDeferred } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import {
  registerPtyHandlers,
  registerSshPtyProvider,
  deletePtyOwnership,
  setPtyOwnership,
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

  it('routes runtime foreground confirmation to the provider owning the captured PTY', async () => {
    const confirmForegroundProcess = vi.fn(async () => 'codex')
    registerSshPtyProvider('ssh-1', { confirmForegroundProcess } as never)
    setPtyOwnership('remote-pty', 'ssh-1')
    const runtime = { setPtyController: vi.fn() }
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      confirmForegroundProcess: (ptyId: string) => Promise<string | null>
    }

    await expect(controller.confirmForegroundProcess('remote-pty')).resolves.toBe('codex')
    expect(confirmForegroundProcess).toHaveBeenCalledOnce()
    expect(confirmForegroundProcess).toHaveBeenCalledWith('remote-pty')
    deletePtyOwnership('remote-pty')
  })
  it('routes runtime exact liveness without enumerating provider sessions', () => {
    const provider = getLocalPtyProvider()
    const hasPty = vi.spyOn(provider, 'hasPty').mockImplementation((id) => id === 'live-pty')
    const listProcesses = vi.spyOn(provider, 'listProcesses')
    const runtime = { setPtyController: vi.fn() }
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      hasPty: (ptyId: string) => boolean | null
    }

    expect(controller.hasPty('live-pty')).toBe(true)
    expect(controller.hasPty('missing-pty')).toBe(false)
    expect(hasPty).toHaveBeenCalledTimes(2)
    expect(listProcesses).not.toHaveBeenCalled()
  })
  it('scopes runtime inventories to the requested provider', async () => {
    const localList = vi
      .spyOn(getLocalPtyProvider(), 'listProcesses')
      .mockResolvedValue([{ id: 'local-pty', title: 'Local', cwd: '/local' }])
    const sshAList = vi.fn(async () => [{ id: 'ssh-a-pty' }])
    const sshBList = vi.fn(async () => {
      throw new Error('ssh-b unavailable')
    })
    registerSshPtyProvider('ssh-a', { listProcesses: sshAList } as never)
    registerSshPtyProvider('ssh-b', { listProcesses: sshBList } as never)
    setPtyOwnership('ssh-b-pty', 'ssh-b')
    const runtime = {
      setPtyController: vi.fn(),
      markPtyLivenessUnverifiable: vi.fn()
    }
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      listProcesses(connectionId?: string | null): Promise<{ id: string }[]>
      listProcessesWithHostScope(): Promise<{ processes: { id: string }[]; hostIds: string[] }>
    }

    await expect(controller.listProcesses(null)).resolves.toEqual([
      { id: 'local-pty', title: 'Local', cwd: '/local' }
    ])
    expect(localList).toHaveBeenCalledOnce()
    expect(sshAList).not.toHaveBeenCalled()
    expect(sshBList).not.toHaveBeenCalled()

    await expect(controller.listProcesses('ssh-a')).resolves.toEqual([{ id: 'ssh-a-pty' }])
    expect(sshAList).toHaveBeenCalledOnce()
    expect(sshBList).not.toHaveBeenCalled()

    // STA-517: the aggregate used to propagate ssh-b's failure, which cost the runtime the
    // whole liveness inventory — so no PTY was ever proven dead and mobile kept every
    // retained pane "active". One unreachable relay now drops out of the answer instead.
    await expect(controller.listProcesses()).resolves.toEqual([
      { id: 'local-pty', title: 'Local', cwd: '/local' },
      { id: 'ssh-a-pty' }
    ])
    expect(sshBList).toHaveBeenCalledOnce()
    expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
      'ssh-b-pty',
      'ssh-b unavailable'
    )

    await expect(controller.listProcessesWithHostScope()).resolves.toEqual({
      processes: [{ id: 'local-pty', title: 'Local', cwd: '/local' }, { id: 'ssh-a-pty' }],
      hostIds: [LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId('ssh-a')]
    })
    expect(sshBList).toHaveBeenCalledTimes(2)
    deletePtyOwnership('ssh-b-pty')
  })
  it('returns unavailable runtime confirmation for unsupported or missing providers', async () => {
    registerSshPtyProvider('ssh-1', {} as never)
    setPtyOwnership('unsupported-pty', 'ssh-1')
    setPtyOwnership('missing-pty', 'missing-connection')
    const runtime = { setPtyController: vi.fn() }
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      confirmForegroundProcess: (ptyId: string) => Promise<string | null>
    }

    await expect(controller.confirmForegroundProcess('unsupported-pty')).resolves.toBeNull()
    await expect(controller.confirmForegroundProcess('missing-pty')).resolves.toBeNull()
    deletePtyOwnership('unsupported-pty')
    deletePtyOwnership('missing-pty')
  })
  it('rethrows non-not-found local provider shutdown failures', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn().mockRejectedValue(new Error('daemon unavailable')),
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
    handlers.clear()
    registerPtyHandlers(mainWindow as never)

    await expect(handlers.get('pty:kill')!(null, { id: 'local-pty' })).rejects.toThrow(
      'daemon unavailable'
    )
  })
  it('rejects runtime terminal IDs before unowned local provider routing', async () => {
    const shutdown = vi.spyOn(getLocalPtyProvider(), 'shutdown')
    handlers.clear()
    registerPtyHandlers(mainWindow as never)

    await expect(
      handlers.get('pty:kill')!(null, { id: 'remote:env-1@@terminal-1' })
    ).rejects.toThrow('Invalid PTY provider id')
    expect(shutdown).not.toHaveBeenCalled()
  })
  it('synthesizes runtime exit after ordinary daemon-backed pty kill', async () => {
    const shutdown = vi.fn(async () => undefined)
    const runtime = {
      setPtyController: vi.fn(),
      onPtyExit: vi.fn()
    }
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown,
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
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:kill')!(null, { id: 'local-pty', keepHistory: true })

    expect(shutdown).toHaveBeenCalledWith('local-pty', {
      immediate: true,
      keepHistory: true
    })
    expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', -1, undefined)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:exit', {
      id: 'local-pty',
      code: -1
    })
  })
  it('does not synthesize a duplicate renderer exit when kill emits provider exit', async () => {
    const exitListeners = new Set<(payload: { id: string; code: number }) => void>()
    const shutdown = vi.fn(async (id: string) => {
      for (const listener of exitListeners) {
        listener({ id, code: 0 })
      }
    })
    const runtime = {
      setPtyController: vi.fn(),
      onPtyExit: vi.fn()
    }
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown,
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
      onExit: vi.fn((listener: (payload: { id: string; code: number }) => void) => {
        exitListeners.add(listener)
        return () => exitListeners.delete(listener)
      }),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:kill')!(null, { id: 'local-pty' })

    expect(runtime.onPtyExit).toHaveBeenCalledTimes(1)
    expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', 0, undefined, {
      providerExitObserved: true
    })
    expect(mainWindow.webContents.send.mock.calls.filter((call) => call[0] === 'pty:exit')).toEqual(
      [['pty:exit', { id: 'local-pty', code: 0 }]]
    )
  })
  it('ignores a late provider exit after synthesizing kill exit', async () => {
    const exitListeners = new Set<(payload: { id: string; code: number }) => void>()
    const runtime = {
      setPtyController: vi.fn(),
      onPtyExit: vi.fn()
    }
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(async () => undefined),
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
      onExit: vi.fn((listener: (payload: { id: string; code: number }) => void) => {
        exitListeners.add(listener)
        return () => exitListeners.delete(listener)
      }),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:kill')!(null, { id: 'local-pty' })
    for (const listener of exitListeners) {
      listener({ id: 'local-pty', code: 0 })
    }

    expect(runtime.onPtyExit).toHaveBeenCalledTimes(1)
    expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', -1, undefined)
    expect(mainWindow.webContents.send.mock.calls.filter((call) => call[0] === 'pty:exit')).toEqual(
      [['pty:exit', { id: 'local-pty', code: -1 }]]
    )
  })
  it('waits for the desktop startup barrier before renderer local spawns resolve the provider', async () => {
    const barrier = makeDeferred()
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        awaitLocalPtyStartup: () => barrier.promise
      }
    )

    const pendingSpawn = handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    }) as Promise<{ id: string }>

    await Promise.resolve()
    expect(spawnMock).not.toHaveBeenCalled()

    const daemonSpawn = installDaemonTestProvider()
    barrier.resolve()
    const result = await pendingSpawn

    expect(daemonSpawn).toHaveBeenCalledTimes(1)
    expect(result.id).toBe(daemonSpawn.mock.calls[0]?.[0].sessionId)
    expect(spawnMock).not.toHaveBeenCalled()
  })
  // Why: cold-start teardown must select the daemon after startup, else fallback shutdown orphans the restored daemon PTY (#7742).
  it('waits for the desktop startup barrier before renderer local kills resolve the provider', async () => {
    const barrier = makeDeferred()
    const awaitLocalPtyStartup = vi.fn(() => new Promise<void>(() => {}))
    const awaitLocalPtyProviderStartup = vi.fn(() => barrier.promise)
    const fallbackShutdown = vi.spyOn(getLocalPtyProvider(), 'shutdown')
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        awaitLocalPtyStartup,
        awaitLocalPtyProviderStartup
      }
    )

    const daemonSessionId = 'wt-1@@11111111-1111-1111-1111-111111111111'
    const pendingKill = handlers.get('pty:kill')!(null, { id: daemonSessionId }) as Promise<void>

    await Promise.resolve()
    expect(awaitLocalPtyStartup).not.toHaveBeenCalled()
    expect(awaitLocalPtyProviderStartup).toHaveBeenCalledTimes(1)
    expect(fallbackShutdown).not.toHaveBeenCalled()
    const daemon = installObservableDaemonTestProvider()
    barrier.resolve()
    await pendingKill

    expect(daemon.spawn).not.toHaveBeenCalled()
    expect(daemon.shutdown).toHaveBeenCalledWith(
      daemonSessionId,
      expect.objectContaining({ immediate: true })
    )
    expect(fallbackShutdown).not.toHaveBeenCalled()
  })
  it('waits for the desktop startup barrier before runtime local kills resolve the provider', async () => {
    const barrier = makeDeferred()
    const awaitLocalPtyProviderStartup = vi.fn(() => barrier.promise)
    const fallbackShutdown = vi.spyOn(getLocalPtyProvider(), 'shutdown')
    const runtime = { setPtyController: vi.fn(), onPtyExit: vi.fn() }
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        awaitLocalPtyProviderStartup
      }
    )
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      kill: (ptyId: string) => boolean
    }

    expect(controller.kill('daemon-session')).toBe(true)
    await Promise.resolve()
    expect(awaitLocalPtyProviderStartup).toHaveBeenCalledTimes(1)
    expect(fallbackShutdown).not.toHaveBeenCalled()

    const daemon = installObservableDaemonTestProvider()
    barrier.resolve()
    await vi.waitFor(() => expect(daemon.shutdown).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(runtime.onPtyExit).toHaveBeenCalledTimes(1))

    expect(daemon.shutdown).toHaveBeenCalledWith('daemon-session', { immediate: false })
    expect(fallbackShutdown).not.toHaveBeenCalled()
  })
  it('waits for the desktop startup barrier before runtime exact stops resolve the provider', async () => {
    const barrier = makeDeferred()
    const awaitLocalPtyProviderStartup = vi.fn(() => barrier.promise)
    const fallbackShutdown = vi.spyOn(getLocalPtyProvider(), 'shutdown')
    const runtime = { setPtyController: vi.fn(), onPtyExit: vi.fn() }
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        awaitLocalPtyProviderStartup
      }
    )
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      stopAndWait: (ptyId: string) => Promise<boolean>
    }

    const pendingStop = controller.stopAndWait('daemon-session')
    await Promise.resolve()
    expect(awaitLocalPtyProviderStartup).toHaveBeenCalledTimes(1)
    expect(fallbackShutdown).not.toHaveBeenCalled()

    const daemon = installObservableDaemonTestProvider()
    barrier.resolve()
    await expect(pendingStop).resolves.toBe(true)

    expect(daemon.shutdown).toHaveBeenCalledWith('daemon-session', {
      immediate: true,
      keepHistory: false
    })
    expect(fallbackShutdown).not.toHaveBeenCalled()
  })
  it('rebinds local data and exit listeners after a late daemon provider install', async () => {
    vi.useFakeTimers()
    const barrier = makeDeferred()
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn(() => 13),
      createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-1'),
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
        {
          awaitLocalPtyStartup: () => barrier.promise
        }
      )

      const pendingSpawn = handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        sessionId: 'daemon-session'
      }) as Promise<{ id: string }>
      await Promise.resolve()

      const daemon = installObservableDaemonTestProvider()
      rebindLocalProviderListeners()
      barrier.resolve()
      const result = await pendingSpawn

      daemon.emitData(result.id, 'daemon output')
      vi.advanceTimersByTime(2)
      daemon.emitExit(result.id, 0)

      expect(daemon.spawn).toHaveBeenCalledTimes(1)
      expect(runtime.onPtyData).toHaveBeenCalledWith(
        result.id,
        'daemon output',
        expect.any(Number),
        'daemon output'.length,
        undefined
      )
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: result.id,
        data: 'daemon output',
        seq: 13,
        rawLength: 'daemon output'.length
      })
      expect(runtime.onPtyExit).toHaveBeenCalledWith(result.id, 0, undefined, {
        providerExitObserved: true
      })
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:exit', {
        id: result.id,
        code: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
