import { describe, expect, it, vi } from 'vitest'
import {
  existsSyncMock,
  loginPreflightExecFileMock,
  spawnMock,
  openCodeClearPtyMock,
  piClearPtyMock
} from './pty-ipc-mock-registry'
import { posixOnlyIt, makeDisposable } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import * as livePtyGate from '../claude-accounts/live-pty-gate'
import { registerPtyHandlers, setLocalPtyProvider, getLocalPtyProvider } from './pty'
import { join } from 'node:path'
// Why resolved rather than hardcoded: the wrapper tree is content-addressed.
import { getShellReadyWrapperRoot } from '../daemon/shell-ready'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
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

function createExitListeners() {
  const listeners = new Set<(info: { exitCode: number }) => void>()
  return {
    subscribe: vi.fn((listener: (info: { exitCode: number }) => void) => {
      listeners.add(listener)
      return { dispose: vi.fn(() => listeners.delete(listener)) }
    }),
    emit: (info: { exitCode: number }) => {
      for (const listener of listeners) {
        listener(info)
      }
    },
    activeCount: () => listeners.size
  }
}

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  posixOnlyIt('prefers args.env.SHELL and normalizes the child env after fallback', async () => {
    const originalShell = process.env.SHELL
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    existsSyncMock.mockImplementation(
      (targetPath: string) => targetPath !== '/opt/homebrew/bin/bash'
    )

    try {
      process.env.SHELL = '/bin/bash'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        worktreeId: 'repo-1::/tmp',
        env: { SHELL: '/opt/homebrew/bin/bash' }
      })

      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(spawnMock).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l'],
        expect.objectContaining({
          cwd: '/tmp',
          env: expect.objectContaining({
            SHELL: '/bin/zsh',
            ORCA_OPENCODE_CONFIG_DIR: '/tmp/orca-opencode-config',
            ORCA_SHELL_FEATURES: 'overlay,history,markers',
            ZDOTDIR: join(getShellReadyWrapperRoot(), 'zsh')
          })
        })
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Preferred shell "/opt/homebrew/bin/bash" is unavailable')
      )
    } finally {
      warnSpy.mockRestore()
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })
  it('cleans up provider-specific PTY overlays when a PTY is killed', async () => {
    let exitCb: ((info: { exitCode: number }) => void) | undefined
    const proc = {
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCb = cb
        return makeDisposable()
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => {
        // Simulate node-pty behavior: kill triggers onExit callback
        exitCb?.({ exitCode: -1 })
      }),
      process: 'zsh',
      pid: 12345
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never)
    const spawnResult = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }

    await handlers.get('pty:kill')!(null, { id: spawnResult.id })

    expect(openCodeClearPtyMock).toHaveBeenCalledWith(spawnResult.id)
    expect(piClearPtyMock).toHaveBeenCalledWith(spawnResult.id)
  })
  it('retains PTY listeners until physical exit after manual kill IPC', async () => {
    const onDataDisposable = makeDisposable()
    const exitListeners = createExitListeners()
    // Why: hold a stable ref to the kill spy — destroyPtyProcess reassigns proc.kill to a no-op (docs/fix-pty-fd-leak.md), so reading proc.kill.mock later would crash.
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: exitListeners.subscribe,
      write: vi.fn(),
      resize: vi.fn(),
      kill: killSpy,
      process: 'zsh',
      pid: 12345
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never)
    const spawnResult = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }

    let finishSnapshot: (() => void) | undefined
    loginPreflightExecFileMock.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void
      ) => {
        finishSnapshot = () => callback(null, '')
      }
    )
    const killPromise = handlers.get('pty:kill')!(null, { id: spawnResult.id }) as Promise<void>

    await vi.waitFor(() => expect(finishSnapshot).toBeTypeOf('function'))
    expect(killSpy).not.toHaveBeenCalled()
    expect(onDataDisposable.dispose).not.toHaveBeenCalled()
    expect(exitListeners.activeCount()).toBe(1)
    finishSnapshot?.()
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalledTimes(1))
    expect(onDataDisposable.dispose).not.toHaveBeenCalled()
    expect(exitListeners.activeCount()).toBe(1)

    exitListeners.emit({ exitCode: -1 })
    await killPromise

    expect(onDataDisposable.dispose).toHaveBeenCalledTimes(1)
    expect(exitListeners.activeCount()).toBe(0)
  })
  it('retains PTY listeners until physical exit after runtime controller kill', async () => {
    const onDataDisposable = makeDisposable()
    const exitListeners = createExitListeners()
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: exitListeners.subscribe,
      write: vi.fn(),
      resize: vi.fn(),
      kill: killSpy,
      process: 'zsh',
      pid: 12345
    }
    const runtime = {
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_test'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      markPtyStopRequested: vi.fn(),
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never, runtime as never)
    const spawnResult = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const runtimeController = runtime.setPtyController.mock.calls[0]?.[0] as {
      kill: (ptyId: string) => boolean
    }

    expect(runtimeController.kill(spawnResult.id)).toBe(true)
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalledTimes(1))
    expect(onDataDisposable.dispose).not.toHaveBeenCalled()
    expect(exitListeners.activeCount()).toBe(1)

    exitListeners.emit({ exitCode: -1 })
    await vi.waitFor(() => expect(exitListeners.activeCount()).toBe(0))
    expect(onDataDisposable.dispose).toHaveBeenCalledTimes(1)
  })
  it('retains daemon PTY listeners across renderer reload until physical exit', async () => {
    const onDataDisposable = makeDisposable()
    const exitListeners = createExitListeners()
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: exitListeners.subscribe,
      write: vi.fn(),
      resize: vi.fn(),
      kill: killSpy,
      process: 'zsh',
      pid: 12345
    }
    const runtime = {
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_test'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      markPtyStopRequested: vi.fn(),
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never, runtime as never)
    // Why both: a reload fires the gate reset AND the orphan cleanup, so invoke every registered listener like a real did-finish-load.
    const didFinishLoadHandlers = mainWindow.webContents.on.mock.calls
      .filter(([eventName]) => eventName === 'did-finish-load')
      .map(([, handler]) => handler as () => void)
    expect(didFinishLoadHandlers.length).toBeGreaterThan(0)
    const didFinishLoad = (): void => {
      for (const handler of didFinishLoadHandlers) {
        handler()
      }
    }
    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    // Renderer reload does not transfer termination authority from the daemon.
    didFinishLoad()
    didFinishLoad()

    expect(killSpy).not.toHaveBeenCalled()
    expect(onDataDisposable.dispose).not.toHaveBeenCalled()
    expect(exitListeners.activeCount()).toBe(1)

    exitListeners.emit({ exitCode: -1 })
    expect(exitListeners.activeCount()).toBe(0)
  })
  it('removes the previous renderer-reset listener from its original webContents', () => {
    const firstWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: {
        on: vi.fn(),
        send: vi.fn(),
        removeListener: vi.fn()
      }
    }
    const secondWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: {
        on: vi.fn(),
        send: vi.fn(),
        removeListener: vi.fn()
      }
    }

    registerPtyHandlers(firstWindow as never)
    // The daemon owns terminal lifetime; only renderer delivery resets on load.
    const firstWindowLoadHandlers = firstWindow.webContents.on.mock.calls.filter(
      ([eventName]) => eventName === 'did-finish-load'
    )
    expect(firstWindowLoadHandlers).toHaveLength(1)

    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    registerPtyHandlers(secondWindow as never)

    // Every first-window load listener was detached from its webContents.
    for (const [, handler] of firstWindowLoadHandlers) {
      expect(firstWindow.webContents.removeListener).toHaveBeenCalledWith(
        'did-finish-load',
        handler
      )
    }
    // Re-registering keeps exactly one delivery-reset listener.
    expect(
      secondWindow.webContents.on.mock.calls.filter(
        ([eventName]) => eventName === 'did-finish-load'
      )
    ).toHaveLength(1)
  })
  // Why (#5787): a recovery reload re-fires did-finish-load; suppress the orphan sweep so live LOCAL PTYs survive until session restore re-adopts them.
  it('does not sweep local PTYs during a recovery reload', async () => {
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: killSpy,
      process: 'zsh',
      pid: 12345
    }
    const runtime = {
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_test'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      markPtyStopRequested: vi.fn(),
      setPtyController: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    spawnMock.mockReturnValue(proc)
    const isRecoveryReloadInFlight = vi.fn(() => true)
    const markClaudePtyExitedSpy = vi.spyOn(livePtyGate, 'markClaudePtyExited')

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { isRecoveryReloadInFlight }
    )
    // Fire both did-finish-load listeners as a real reload does, else the suppression assertion passes vacuously without reaching the sweep.
    const didFinishLoadHandlers = mainWindow.webContents.on.mock.calls
      .filter(([eventName]) => eventName === 'did-finish-load')
      .map(([, handler]) => handler as () => void)
    expect(didFinishLoadHandlers.length).toBeGreaterThan(0)
    const didFinishLoad = (): void => didFinishLoadHandlers.forEach((handler) => handler())

    const spawnResult = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as {
      id: string
      incarnationId: string
    }

    // Without the guard the second load would sweep this PTY as a prior-generation orphan; under recovery-in-flight neither load may touch it.
    didFinishLoad()
    didFinishLoad()

    expect(killSpy).not.toHaveBeenCalled()
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(markClaudePtyExitedSpy).not.toHaveBeenCalled()
    const listed = await getLocalPtyProvider().listProcesses()
    expect(listed.some((info) => info.id === spawnResult.id)).toBe(true)

    markClaudePtyExitedSpy.mockRestore()
  })
  it('preserves daemon terminals across ordinary reload and reports subsequent physical exit', async () => {
    let exitCb: ((info: { exitCode: number }) => void) | undefined
    const killSpy = vi.fn(() => {
      queueMicrotask(() => exitCb?.({ exitCode: -1 }))
    })
    const proc = {
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCb = cb
        return makeDisposable()
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: killSpy,
      process: 'zsh',
      pid: 12345
    }
    const runtime = {
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_test'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      markPtyStopRequested: vi.fn(),
      setPtyController: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    spawnMock.mockReturnValue(proc)
    const isRecoveryReloadInFlight = vi.fn(() => false)

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { isRecoveryReloadInFlight }
    )
    // Fire both did-finish-load listeners (gate reset + orphan sweep) as a real reload does.
    const didFinishLoadHandlers = mainWindow.webContents.on.mock.calls
      .filter(([eventName]) => eventName === 'did-finish-load')
      .map(([, handler]) => handler as () => void)
    const didFinishLoad = (): void => didFinishLoadHandlers.forEach((handler) => handler())

    const spawnResult = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as {
      id: string
      incarnationId: string
    }

    // First load only advances generation; the second sees this PTY as a prior-load orphan — with the flag false the guard must NOT suppress the sweep.
    didFinishLoad()
    didFinishLoad()
    await Promise.resolve()

    expect(killSpy).not.toHaveBeenCalled()
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(
      (await getLocalPtyProvider().listProcesses()).some((info) => info.id === spawnResult.id)
    ).toBe(true)
    exitCb?.({ exitCode: -1 })
    expect(runtime.onPtyExit).toHaveBeenCalledWith(spawnResult.id, -1, spawnResult.incarnationId, {
      providerExitObserved: true,
      cause: { kind: 'unknown', reason: 'stop_unverified' }
    })
    const listed = await getLocalPtyProvider().listProcesses()
    expect(listed.some((info) => info.id === spawnResult.id)).toBe(false)
  })
  // Why (#5787): two PTYs in different load generations must BOTH survive a recovery reload — even the older one a normal sweep would reclaim.
  it('keeps local PTYs from different generations alive across recovery reloads', async () => {
    const killSpyA = vi.fn()
    const killSpyB = vi.fn()
    const runtime = {
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_test'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      markPtyStopRequested: vi.fn(),
      setPtyController: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    const isRecoveryReloadInFlight = vi.fn(() => true)

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { isRecoveryReloadInFlight }
    )
    // Fire ALL did-finish-load listeners (gate reset + orphan sweep) as a real reload does; the sweep listener is under test.
    const didFinishLoadHandlers = mainWindow.webContents.on.mock.calls
      .filter(([eventName]) => eventName === 'did-finish-load')
      .map(([, handler]) => handler as () => void)
    const didFinishLoad = (): void => didFinishLoadHandlers.forEach((handler) => handler())

    spawnMock.mockReturnValue({
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: killSpyA,
      process: 'zsh',
      pid: 111
    })
    const ptyA = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as { id: string }

    // Advance the generation without sweeping (recovery-in-flight), then spawn a second PTY so the two live in different generations.
    didFinishLoad()

    spawnMock.mockReturnValue({
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: killSpyB,
      process: 'zsh',
      pid: 222
    })
    const ptyB = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as { id: string }

    didFinishLoad()

    expect(killSpyA).not.toHaveBeenCalled()
    expect(killSpyB).not.toHaveBeenCalled()
    const ids = (await getLocalPtyProvider().listProcesses()).map((info) => info.id)
    expect(ids).toContain(ptyA.id)
    expect(ids).toContain(ptyB.id)
  })
  it('retains PTY state when kill fails until physical exit arrives', async () => {
    let exitCb: ((info: { exitCode: number }) => void) | undefined
    const proc = {
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCb = cb
        return makeDisposable()
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => {
        throw new Error('already dead')
      }),
      process: 'zsh',
      pid: 12345
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never)
    const spawnResult = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }

    await expect(handlers.get('pty:kill')!(null, { id: spawnResult.id })).rejects.toThrow(
      'kill ESRCH'
    )

    expect((await getLocalPtyProvider().listProcesses()).map(({ id }) => id)).toContain(
      spawnResult.id
    )
    expect(openCodeClearPtyMock).not.toHaveBeenCalled()
    expect(piClearPtyMock).not.toHaveBeenCalled()

    exitCb?.({ exitCode: -1 })

    expect((await getLocalPtyProvider().listProcesses()).map(({ id }) => id)).not.toContain(
      spawnResult.id
    )
    expect(openCodeClearPtyMock).toHaveBeenCalledWith(spawnResult.id)
    expect(piClearPtyMock).toHaveBeenCalledWith(spawnResult.id)
  })
})
