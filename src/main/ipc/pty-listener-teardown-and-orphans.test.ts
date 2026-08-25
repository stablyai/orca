import { describe, expect, it, vi } from 'vitest'
import {
  existsSyncMock,
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
import { getShellReadyWrapperRoot } from '../providers/local-pty-shell-ready-wrapper-root'

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
    const onExitDisposable = makeDisposable()
    let exitCb: ((info: { exitCode: number }) => void) | undefined
    // Why: hold a stable ref to the kill spy — destroyPtyProcess reassigns proc.kill to a no-op (docs/fix-pty-fd-leak.md), so reading proc.kill.mock later would crash.
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

    const killPromise = handlers.get('pty:kill')!(null, { id: spawnResult.id }) as Promise<void>

    expect(killSpy).toHaveBeenCalledTimes(1)
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

    // First load after spawn only advances generation; the second sees this PTY as from a prior load and kills it as orphaned.
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
    // Two listeners on the first (LocalPtyProvider) window: the renderer-gate reset and the orphan cleanup.
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

    // Every first-window load listener was detached from its webContents.
    for (const [, handler] of firstWindowLoadHandlers) {
      expect(firstWindow.webContents.removeListener).toHaveBeenCalledWith(
        'did-finish-load',
        handler
      )
    }
    // The non-Local provider keeps orphan cleanup off the second window — only the renderer-gate reset listener remains.
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
  // Why: guard against over-suppression — with no recovery reload in flight the sweep MUST still reclaim genuinely orphaned local PTYs.
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

    expect(killSpy).toHaveBeenCalled()
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
