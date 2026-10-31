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
import { registerPtyHandlers } from './register-handlers'
import { setLocalPtyProvider, getLocalPtyProvider } from './provider/registry'
import { join } from 'node:path'
// Wrapper roots are content-addressed.
import { getShellReadyWrapperRoot } from '../../providers/local-pty-shell-ready-wrapper-root'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

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
        expect.stringContaining('Primary shell "/opt/homebrew/bin/bash" failed')
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
    const onExitDisposable = makeDisposable()
    let exitCb: ((info: { exitCode: number }) => void) | undefined
    // Keep the original spy: destroyPtyProcess replaces proc.kill with a no-op.
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCb = cb
        return onExitDisposable
      }),
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
    expect(onExitDisposable.dispose).not.toHaveBeenCalled()
    finishSnapshot?.()
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalledTimes(1))
    expect(onDataDisposable.dispose).not.toHaveBeenCalled()
    expect(onExitDisposable.dispose).not.toHaveBeenCalled()

    exitCb?.({ exitCode: -1 })
    await killPromise

    expect(onDataDisposable.dispose).toHaveBeenCalledTimes(1)
    expect(onExitDisposable.dispose).toHaveBeenCalledTimes(1)
  })
  it('retains PTY listeners until physical exit after runtime controller kill', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()
    let exitCb: ((info: { exitCode: number }) => void) | undefined
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCb = cb
        return onExitDisposable
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: killSpy,
      process: 'zsh',
      pid: 12345
    }
    const runtime = {
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
    expect(onExitDisposable.dispose).not.toHaveBeenCalled()

    exitCb?.({ exitCode: -1 })
    await vi.waitFor(() => expect(onExitDisposable.dispose).toHaveBeenCalledTimes(1))
    expect(onDataDisposable.dispose).toHaveBeenCalledTimes(1)
  })
  it('retains the PTY exit listener through did-finish-load orphan cleanup', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()
    let exitCb: ((info: { exitCode: number }) => void) | undefined
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCb = cb
        return onExitDisposable
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: killSpy,
      process: 'zsh',
      pid: 12345
    }
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never, runtime as never)
    // Fire all load listeners so gate reset cannot hide a missing orphan sweep.
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

    // First load advances generation; the second can identify the prior-load PTY as orphaned.
    didFinishLoad()
    didFinishLoad()

    expect(onDataDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killSpy.mock.invocationCallOrder[0]
    )
    expect(onExitDisposable.dispose).not.toHaveBeenCalled()

    exitCb?.({ exitCode: -1 })
    expect(onExitDisposable.dispose).toHaveBeenCalledTimes(1)
  })
  it('removes the previous orphan-cleanup listener from its original webContents', () => {
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
    const firstWindowLoadHandlers = firstWindow.webContents.on.mock.calls.filter(
      ([eventName]) => eventName === 'did-finish-load'
    )
    expect(firstWindowLoadHandlers).toHaveLength(2)

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

    for (const [, handler] of firstWindowLoadHandlers) {
      expect(firstWindow.webContents.removeListener).toHaveBeenCalledWith(
        'did-finish-load',
        handler
      )
    }
    expect(
      secondWindow.webContents.on.mock.calls.filter(
        ([eventName]) => eventName === 'did-finish-load'
      )
    ).toHaveLength(1)
  })
  // Recovery reload must preserve live local PTYs until restore re-adopts them (#5787).
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
      setPtyController: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    spawnMock.mockReturnValue(proc)
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
    // Fire all load listeners so this assertion actually reaches orphan cleanup.
    const didFinishLoadHandlers = mainWindow.webContents.on.mock.calls
      .filter(([eventName]) => eventName === 'did-finish-load')
      .map(([, handler]) => handler as () => void)
    expect(didFinishLoadHandlers.length).toBeGreaterThan(0)
    const didFinishLoad = (): void => didFinishLoadHandlers.forEach((handler) => handler())

    const spawnResult = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as {
      id: string
      incarnationId: string
    }

    didFinishLoad()
    didFinishLoad()

    expect(killSpy).not.toHaveBeenCalled()
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    const listed = await getLocalPtyProvider().listProcesses()
    expect(listed.some((info) => info.id === spawnResult.id)).toBe(true)
  })
  it('still sweeps orphaned local PTYs when no recovery reload is in flight', async () => {
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
    const didFinishLoadHandlers = mainWindow.webContents.on.mock.calls
      .filter(([eventName]) => eventName === 'did-finish-load')
      .map(([, handler]) => handler as () => void)
    const didFinishLoad = (): void => didFinishLoadHandlers.forEach((handler) => handler())

    const spawnResult = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as {
      id: string
      incarnationId: string
    }

    // Normal second load must reclaim the prior-generation orphan.
    didFinishLoad()
    didFinishLoad()
    await Promise.resolve()

    expect(killSpy).toHaveBeenCalled()
    expect(runtime.onPtyExit).toHaveBeenCalledWith(spawnResult.id, -1, spawnResult.incarnationId, {
      providerExitObserved: true,
      cause: { kind: 'operator_close' }
    })
    const listed = await getLocalPtyProvider().listProcesses()
    expect(listed.some((info) => info.id === spawnResult.id)).toBe(false)
  })
  it('keeps local PTYs from different generations alive across recovery reloads', async () => {
    const killSpyA = vi.fn()
    const killSpyB = vi.fn()
    const runtime = {
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

    // Recovery advances generation without sweeping; a second spawn creates mixed-generation live PTYs.
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
      'already dead'
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
