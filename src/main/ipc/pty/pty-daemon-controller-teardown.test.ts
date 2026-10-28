import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './register-handlers'
import { setPtyOwnership } from './provider/ownership-state'
import { setLocalPtyProvider } from './provider/registry'
import type { IPtyProvider } from '../../providers/pty-provider-contract'
import type { RuntimePtyController } from '../../runtime/runtime-pty-controller-contract'
import { TerminalIntentionalStops } from '../../runtime/terminal-intentional-stops'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../shared/pty-liveness-verdict'

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

  describe('spawn environment', () => {
    describe('daemon-active provider (parity with LocalPtyProvider)', () => {
      it('runtime controller stopAndWait fails when keepHistory allows the PTY to revive', async () => {
        vi.useFakeTimers()
        const shutdown = vi.fn(async () => undefined)
        const listProcesses = vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: 'local-pty', cwd: '/tmp/demo', title: 'shell' }])
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
          listProcesses,
          attach: vi.fn(),
          getDefaultShell: vi.fn(),
          getProfiles: vi.fn()
        } as never)
        const runtime = {
          setPtyController: vi.fn(),
          onPtyExit: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          stopAndWait: (ptyId: string, opts?: { keepHistory?: boolean }) => Promise<boolean>
        }

        const stopPromise = controller.stopAndWait('local-pty', { keepHistory: true })
        await vi.advanceTimersByTimeAsync(200)

        await expect(stopPromise).resolves.toBe(false)
        expect(shutdown).toHaveBeenCalledWith('local-pty', {
          immediate: true,
          keepHistory: true
        })
        expect(runtime.onPtyExit).not.toHaveBeenCalled()
      })
      it('runtime controller stopAndWait preserves ownership when proof fails after shutdown', async () => {
        const shutdown = vi.fn(async () => undefined)
        const listProcesses = vi.fn().mockRejectedValue(new Error('legacy unavailable'))
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
          listProcesses,
          attach: vi.fn(),
          getDefaultShell: vi.fn(),
          getProfiles: vi.fn()
        } as never)
        const runtime = {
          setPtyController: vi.fn(),
          onPtyExit: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          stopAndWait: (ptyId: string, opts?: { keepHistory?: boolean }) => Promise<boolean>
        }

        await expect(controller.stopAndWait('local-pty', { keepHistory: true })).resolves.toBe(
          false
        )

        expect(shutdown).toHaveBeenCalledWith('local-pty', {
          immediate: true,
          keepHistory: true
        })
        expect(runtime.onPtyExit).not.toHaveBeenCalled()
      })
      it('bounds keep-history inventory polls by the settlement deadline', async () => {
        vi.useFakeTimers()
        try {
          const listProcesses = vi.fn(async (_opts?: { deadlineMs?: number }) => [])
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
            onExit: vi.fn(() => () => {}),
            listProcesses,
            getDefaultShell: vi.fn(),
            getProfiles: vi.fn()
          } as never)
          const runtime = {
            setPtyController: vi.fn(),
            onPtyExit: vi.fn()
          }
          handlers.clear()
          registerPtyHandlers(mainWindow as never, runtime as never)
          const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
            stopAndWait: (
              ptyId: string,
              opts?: { keepHistory?: boolean; deadlineMs?: number }
            ) => Promise<boolean>
          }
          const callerDeadlineMs = Date.now() + 5_000
          const stopPromise = controller.stopAndWait('local-pty', {
            keepHistory: true,
            deadlineMs: callerDeadlineMs
          })

          await vi.advanceTimersByTimeAsync(1_000)
          await expect(stopPromise).resolves.toBe(true)

          expect(listProcesses.mock.calls[0]?.[0]).toEqual({
            deadlineMs: callerDeadlineMs,
            ptyIds: ['local-pty']
          })
          const settlementDeadlines = listProcesses.mock.calls
            .slice(1)
            .map(([opts]) => opts?.deadlineMs)
          expect(settlementDeadlines.length).toBeGreaterThan(0)
          expect(new Set(settlementDeadlines)).toEqual(new Set([callerDeadlineMs - 4_000]))
        } finally {
          vi.useRealTimers()
        }
      })
      it('uses inventory, not an incarnation-less exit, to confirm the current PTY stopped', async () => {
        const exitListeners = new Set<
          (payload: { id: string; code: number; incarnationId?: string }) => void
        >()
        const provider = {
          spawn: vi.fn(async () => ({ id: 'local-incarnated', incarnationId: 'incarnation-live' })),
          write: vi.fn(),
          resize: vi.fn(),
          shutdown: vi.fn(async () => {
            for (const listener of exitListeners) {
              listener({ id: 'local-incarnated', code: 0 })
            }
          }),
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
          onExit: vi.fn((listener) => {
            exitListeners.add(listener)
            return () => exitListeners.delete(listener)
          }),
          listProcesses: vi.fn(async () => []),
          attach: vi.fn(),
          getDefaultShell: vi.fn(),
          getProfiles: vi.fn()
        }
        setLocalPtyProvider(provider as never)
        const runtime = {
          setPtyController: vi.fn(),
          onPtyExit: vi.fn(),
          registerPty: vi.fn(),
          onPtySpawned: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          spawn: (args: { cols: number; rows: number }) => Promise<{ id: string }>
          stopAndWait: (ptyId: string) => Promise<boolean>
        }

        await controller.spawn({ cols: 80, rows: 24 })
        await expect(controller.stopAndWait('local-incarnated')).resolves.toBe(true)

        expect(runtime.onPtyExit).toHaveBeenCalledWith('local-incarnated', 0, 'incarnation-live')
      })
      it('skips the keep-history settle poll once this incarnation exit was observed', async () => {
        const exitListeners = new Set<
          (payload: { id: string; code: number; incarnationId?: string }) => void
        >()
        const listProcesses = vi.fn(async () => [])
        const provider: IPtyProvider = {
          spawn: vi.fn(async () => ({ id: 'local-sleeping', incarnationId: 'incarnation-1' })),
          write: vi.fn(),
          writeWithSettlement: vi.fn(),
          resetInputModes: vi.fn(),
          resize: vi.fn(),
          shutdown: vi.fn(async () => {
            for (const listener of exitListeners) {
              listener({ id: 'local-sleeping', code: 0, incarnationId: 'incarnation-1' })
            }
          }),
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
          onExit: vi.fn((listener) => {
            exitListeners.add(listener)
            return () => exitListeners.delete(listener)
          }),
          listProcesses,
          attach: vi.fn(),
          getDefaultShell: vi.fn(),
          getProfiles: vi.fn()
        }
        setLocalPtyProvider(provider)
        const runtime = {
          setPtyController: vi.fn<(controller: RuntimePtyController) => void>(),
          onPtyExit: vi.fn(),
          registerPty: vi.fn(),
          onPtySpawned: vi.fn()
        }
        handlers.clear()
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only the stubbed runtime members.
        registerPtyHandlers(mainWindow as never, runtime as never)
        const controller = runtime.setPtyController.mock.calls[0]?.[0]

        await controller?.spawn?.({ cols: 80, rows: 24 })
        const startedAt = Date.now()
        await expect(
          controller?.stopAndWait?.('local-sleeping', { keepHistory: true })
        ).resolves.toBe(true)

        expect(listProcesses).toHaveBeenCalledTimes(1)
        expect(Date.now() - startedAt).toBeLessThan(500)
      })
      it('runtime controller kill tombstones app-scoped SSH ids when ownership and provider are absent', async () => {
        const localShutdown = vi.fn()
        setLocalPtyProvider({
          spawn: vi.fn(),
          write: vi.fn(),
          resize: vi.fn(),
          shutdown: localShutdown,
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
        const store = { markSshRemotePtyLease: vi.fn() }
        const runtime = {
          setPtyController: vi.fn(),
          onPtyExit: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(
          mainWindow as never,
          runtime as never,
          undefined,
          undefined,
          undefined,
          store as never
        )
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          kill: (ptyId: string) => boolean
        }

        // Tombstoning the lease does not prove its detached relay PTY stopped.
        expect(controller.kill('ssh:ssh-1@@relay-pty')).toBe(false)

        expect(localShutdown).not.toHaveBeenCalled()
        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith(
          'ssh-1',
          'relay-pty',
          expect.objectContaining({ unverifiableReason: SSH_PROVIDER_UNREGISTERED_REASON })
        )
        expect(runtime.onPtyExit).toHaveBeenCalledWith('ssh:ssh-1@@relay-pty', -1, undefined)
      })
      it('marks a detached SSH lease terminated when runtime controller kill has no provider', async () => {
        const store = { markSshRemotePtyLease: vi.fn() }
        const runtime = {
          setPtyController: vi.fn(),
          onPtyExit: vi.fn()
        }
        setPtyOwnership('remote-pty', 'ssh:ssh-1')
        handlers.clear()
        registerPtyHandlers(
          mainWindow as never,
          runtime as never,
          undefined,
          undefined,
          undefined,
          store as never
        )
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          kill: (ptyId: string) => boolean
        }

        expect(controller.kill('remote-pty')).toBe(false)

        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith(
          'ssh-1',
          'remote-pty',
          expect.objectContaining({ unverifiableReason: SSH_PROVIDER_UNREGISTERED_REASON })
        )
        expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', -1, undefined)
      })
    })
  })
})

describe('PTY SSH lease lifecycle', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  describe('spawn environment', () => {
    describe('daemon-active provider (parity with LocalPtyProvider)', () => {
      it('controller kill does not duplicate exits when the provider emits exit during shutdown', async () => {
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
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          kill: (ptyId: string) => boolean
        }

        expect(controller.kill('local-pty')).toBe(true)
        await Promise.resolve()
        await Promise.resolve()

        expect(runtime.onPtyExit).toHaveBeenCalledTimes(1)
        expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', 0, undefined, {
          providerExitObserved: true
        })
        expect(
          mainWindow.webContents.send.mock.calls.filter((call) => call[0] === 'pty:exit')
        ).toEqual([['pty:exit', { id: 'local-pty', code: 0, hostId: 'local' }]])
      })
      it('controller stopAndWait skips the synthetic exit when the provider emitted one', async () => {
        vi.useFakeTimers()
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
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          stopAndWait: (ptyId: string, opts?: { keepHistory?: boolean }) => Promise<boolean>
        }

        const stopPromise = controller.stopAndWait('local-pty')
        await vi.advanceTimersByTimeAsync(1_200)
        await expect(stopPromise).resolves.toBe(true)

        expect(runtime.onPtyExit).toHaveBeenCalledTimes(1)
        expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', 0, undefined, {
          providerExitObserved: true
        })
        expect(
          mainWindow.webContents.send.mock.calls.filter((call) => call[0] === 'pty:exit')
        ).toEqual([['pty:exit', { id: 'local-pty', code: 0, hostId: 'local' }]])
      })
      it('classifies host reversible-stop exits for the attached renderer', async () => {
        vi.useFakeTimers()
        const exitListeners = new Set<(payload: { id: string; code: number }) => void>()
        const runtime = {
          setPtyController: vi.fn(),
          onPtyExit: vi.fn(),
          intentionalPtyStops: new TerminalIntentionalStops()
        }
        setLocalPtyProvider({
          spawn: vi.fn(),
          write: vi.fn(),
          resize: vi.fn(),
          shutdown: vi.fn(async (id: string) => {
            for (const listener of exitListeners) {
              listener({ id, code: 0 })
            }
          }),
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
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          stopAndWait: (ptyId: string) => Promise<boolean>
        }
        const settleStop = runtime.intentionalPtyStops.mark('local-pty', 'reversible', null)

        const stopPromise = controller.stopAndWait('local-pty')
        await vi.advanceTimersByTimeAsync(1_200)
        await expect(stopPromise).resolves.toBe(true)
        settleStop(true)

        expect(
          mainWindow.webContents.send.mock.calls.filter((call) => call[0] === 'pty:exit')
        ).toEqual([
          ['pty:exit', { id: 'local-pty', code: 0, hostId: 'local', preserveRendererBinding: true }]
        ])
      })
      it('splits the teardown budget so the liveness RPC gets only what shutdown left', async () => {
        // Sequential shutdown/liveness RPCs must share one absolute deadline; freeze time to measure consumed budget.
        vi.useFakeTimers()
        const remainingAtLeaf: number[] = []
        const shutdown = vi.fn(async (_id: string, opts?: { deadlineMs?: number }) => {
          remainingAtLeaf.push((opts?.deadlineMs ?? 0) - Date.now())
          await new Promise<void>((resolve) => setTimeout(resolve, 1000))
        })
        const listProcesses = vi.fn(async (opts?: { deadlineMs?: number }) => {
          remainingAtLeaf.push((opts?.deadlineMs ?? 0) - Date.now())
          return []
        })
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
          listProcesses,
          attach: vi.fn(),
          getDefaultShell: vi.fn(),
          getProfiles: vi.fn()
        } as never)
        const runtime = {
          setPtyController: vi.fn(),
          onPtyExit: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          stopAndWait: (
            ptyId: string,
            opts?: { keepHistory?: boolean; deadlineMs?: number }
          ) => Promise<boolean>
        }

        const deadlineMs = Date.now() + 4321
        const stopPromise = controller.stopAndWait('local-pty', { deadlineMs })
        await vi.advanceTimersByTimeAsync(1000)
        await expect(stopPromise).resolves.toBe(true)

        expect(shutdown).toHaveBeenCalledWith(
          'local-pty',
          expect.objectContaining({ immediate: true, deadlineMs })
        )
        // Liveness receives only the budget remaining after shutdown.
        expect(remainingAtLeaf).toEqual([4321, 3321])
        vi.useRealTimers()
      })
    })
  })
})
