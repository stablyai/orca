import { describe, expect, it, vi } from 'vitest'
import { onMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'

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
  const { handlers, mainWindow, mainWindowIpcEvent } = setupPtyIpcSuite()

  // Why: daemon resize is fire-and-forget, so pty:getSize must report the APPLIED size, not the requested one (Claude-Code split-pane desync).
  describe('pty:getSize reports applied size, not requested size', () => {
    function setupProviderWithAppliedSize(args: {
      applied: { cols: number; rows: number } | null
      resize?: (cols: number, rows: number) => void
      getAppliedSize?: (id: string) => Promise<{ cols: number; rows: number } | null>
    }): ReturnType<typeof vi.fn> {
      const write = vi.fn()
      setLocalPtyProvider({
        spawn: vi.fn(async (opts: { sessionId?: string }) => ({
          id: opts.sessionId ?? 'daemon-pty'
        })),
        write,
        resize: vi.fn(args.resize ?? (() => {})),
        getAppliedSize: vi.fn(args.getAppliedSize ?? (async () => args.applied)),
        kill: vi.fn(),
        shutdown: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        listProcesses: vi.fn(async () => []),
        getForegroundProcess: vi.fn(async () => null)
      } as never)
      return write
    }

    const resizeListener = (): ((event: unknown, args: unknown) => void) => {
      const call = onMock.mock.calls.find((entry: unknown[]) => entry[0] === 'pty:resize')
      if (!call) {
        throw new Error('missing pty:resize listener')
      }
      return call[1] as (event: unknown, args: unknown) => void
    }

    it('returns the applied (wide) size after a dropped narrow resize', async () => {
      // The daemon keeps the PTY at its wide spawn size; the narrow resize is silently dropped (fire-and-forget).
      setupProviderWithAppliedSize({ applied: { cols: 200, rows: 50 } })
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 200, rows: 50, env: {} })
      const id = (spawn as { id: string }).id

      // Renderer forwards a corrective narrow resize; it is dropped daemon-side.
      resizeListener()(mainWindowIpcEvent, { id, cols: 80, rows: 24 })

      // getSize must surface the applied wide size so the renderer detects drift and re-asserts — NOT requested 80.
      const reported = await handlers.get('pty:getSize')!(null, { id })
      expect(reported).toEqual({ cols: 200, rows: 50 })
    })
    it('falls back to the requested size when the provider cannot report applied size', async () => {
      // No getAppliedSize (e.g. SSH relay): requested-size cache is the only signal, so getSize returns it.
      setupProviderWithAppliedSize({ applied: null, getAppliedSize: undefined })
      setLocalPtyProvider({
        spawn: vi.fn(async (opts: { sessionId?: string }) => ({
          id: opts.sessionId ?? 'daemon-pty'
        })),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        shutdown: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        listProcesses: vi.fn(async () => []),
        getForegroundProcess: vi.fn(async () => null)
      } as never)
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 200, rows: 50, env: {} })
      const id = (spawn as { id: string }).id
      resizeListener()(mainWindowIpcEvent, { id, cols: 80, rows: 24 })

      const reported = await handlers.get('pty:getSize')!(null, { id })
      expect(reported).toEqual({ cols: 80, rows: 24 })
    })
    it('preserves provider-owned null so the renderer re-forwards an unverified size', async () => {
      setupProviderWithAppliedSize({ applied: null, getAppliedSize: async () => null })
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 100, rows: 30, env: {} })
      const id = (spawn as { id: string }).id
      resizeListener()(mainWindowIpcEvent, { id, cols: 80, rows: 24 })

      const reported = await handlers.get('pty:getSize')!(null, { id })
      expect(reported).toBeNull()
    })
    it('falls back to the requested size when getAppliedSize throws', async () => {
      // A dead daemon/relay must never throw across the IPC boundary or block.
      setupProviderWithAppliedSize({
        applied: null,
        getAppliedSize: async () => {
          throw new Error('daemon unreachable')
        }
      })
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 100, rows: 30, env: {} })
      const id = (spawn as { id: string }).id

      const reported = await handlers.get('pty:getSize')!(null, { id })
      expect(reported).toEqual({ cols: 100, rows: 30 })
    })
    it('fans out accepted desktop resizes to the runtime after provider resize', async () => {
      const resize = vi.fn()
      setupProviderWithAppliedSize({ applied: { cols: 120, rows: 30 }, resize })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'host' })),
        isResizeSuppressed: vi.fn(() => false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        onExternalPtyResize: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id

      resizeListener()(mainWindowIpcEvent, { id, cols: 120, rows: 30 })

      expect(resize).toHaveBeenCalledWith(id, 120, 30)
      expect(runtime.onExternalPtyResize).toHaveBeenCalledWith(id, 120, 30)
      expect(resize.mock.invocationCallOrder[0]).toBeLessThan(
        runtime.onExternalPtyResize.mock.invocationCallOrder[0]!
      )
    })
    it('does not fan out rejected desktop resizes to the runtime', async () => {
      setupProviderWithAppliedSize({
        applied: { cols: 80, rows: 24 },
        resize: () => {
          throw new Error('resize rejected')
        }
      })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'host' })),
        isResizeSuppressed: vi.fn(() => false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        onExternalPtyResize: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id

      resizeListener()(mainWindowIpcEvent, { id, cols: 120, rows: 30 })

      expect(runtime.onExternalPtyResize).not.toHaveBeenCalled()
    })
    it('suppresses the host fit cascade while a remote viewer drives the width', async () => {
      const resizeSpy = vi.fn()
      setupProviderWithAppliedSize({ applied: { cols: 80, rows: 24 }, resize: resizeSpy })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'idle' })),
        // The fix: a PTY with a remote viewer reports true even though driver state stays idle/desktop.
        isRemoteDesktopResizeDriven: vi.fn(() => true),
        isResizeSuppressed: vi.fn(() => false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        recordRemoteDesktopHostReclaimTarget: vi.fn(),
        onExternalPtyResize: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id
      resizeSpy.mockClear()

      // Host's own safeFit tries to widen the viewed PTY back to its window.
      resizeListener()(mainWindowIpcEvent, { id, cols: 125, rows: 48 })

      // It must not reach the PTY while the viewer owns the width.
      expect(resizeSpy).not.toHaveBeenCalled()
      expect(runtime.recordRemoteDesktopHostReclaimTarget).toHaveBeenCalledWith(id, 125, 48)
      expect(runtime.onExternalPtyResize).not.toHaveBeenCalled()
    })
    it('lets trusted host activity reclaim remote viewport ownership', () => {
      const claimRemoteDesktopHost = vi.fn().mockResolvedValue(true)
      const runtime = {
        setPtyController: vi.fn(),
        claimRemoteDesktopHost
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const call = onMock.mock.calls.find((entry: unknown[]) => entry[0] === 'pty:claimViewport')
      const claimListener = call?.[1] as
        | ((event: unknown, args: { id: string; cols: number; rows: number }) => void)
        | undefined
      expect(claimListener).toBeTypeOf('function')

      claimListener?.(mainWindowIpcEvent, { id: 'pty-1', cols: 125, rows: 48 })

      expect(claimRemoteDesktopHost).toHaveBeenCalledWith('pty-1', 125, 48)
    })
    it('does not forward host input when viewport reclaim fails', async () => {
      const write = setupProviderWithAppliedSize({ applied: { cols: 80, rows: 24 } })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'idle' })),
        claimRemoteDesktopHost: vi.fn().mockResolvedValue(false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id
      const claim = onMock.mock.calls.find((entry: unknown[]) => entry[0] === 'pty:claimViewport')
      const writeEvent = onMock.mock.calls.find((entry: unknown[]) => entry[0] === 'pty:write')

      claim?.[1](mainWindowIpcEvent, { id, cols: 125, rows: 48 })
      writeEvent?.[1](mainWindowIpcEvent, { id, data: 'x' })
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
    })
    it('does not populate the remote reclaim cache when only a phone drives', async () => {
      const resizeSpy = vi.fn()
      setupProviderWithAppliedSize({ applied: { cols: 80, rows: 24 }, resize: resizeSpy })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'mobile', clientId: 'phone-A' })),
        isRemoteDesktopResizeDriven: vi.fn(() => false),
        isResizeSuppressed: vi.fn(() => false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        recordRemoteDesktopHostReclaimTarget: vi.fn(),
        onExternalPtyResize: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id
      resizeSpy.mockClear()

      resizeListener()(mainWindowIpcEvent, { id, cols: 125, rows: 48 })

      expect(resizeSpy).not.toHaveBeenCalled()
      expect(runtime.recordRemoteDesktopHostReclaimTarget).not.toHaveBeenCalled()
      expect(runtime.onExternalPtyResize).not.toHaveBeenCalled()
    })
  })
})
