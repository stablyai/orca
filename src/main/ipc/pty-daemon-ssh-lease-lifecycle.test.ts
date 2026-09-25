import { describe, expect, it, vi } from 'vitest'
import { openCodeClearPtyMock, piClearPtyMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  SSH_PTY_IDENTITY_MISMATCH_ERROR,
  SSH_SESSION_EXPIRED_ERROR
} from '../providers/ssh-pty-errors'
import {
  registerPtyHandlers,
  registerSshPtyProvider,
  deletePtyOwnership,
  setPtyOwnership,
  setLocalPtyProvider
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
  const { handlers, mainWindow, mainWindowIpcEvent, getPtyWriteListener } = setupPtyIpcSuite()

  describe('spawn environment', () => {
    describe('daemon-active provider (parity with LocalPtyProvider)', () => {
      // Why: under the daemon, LocalPtyProvider.buildSpawnEnv never runs, so host-local env injection must happen in the pty:spawn handler instead.
      it('does not clear a scoped SSH session when remote reattach rejects an identity mismatch', async () => {
        const scopedPtyId = 'ssh:ssh-1@@remote-pty'
        const remoteWrite = vi.fn()
        const sshSpawn = vi.fn(async () => {
          throw new Error(
            `${SSH_SESSION_EXPIRED_ERROR}: remote-pty ${SSH_PTY_IDENTITY_MISMATCH_ERROR}`
          )
        })
        const store = {
          markSshRemotePtyLease: vi.fn(),
          clearSshRemotePtyKillIntent: vi.fn()
        }
        registerSshPtyProvider('ssh-1', {
          spawn: sshSpawn,
          write: remoteWrite,
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
        setPtyOwnership(scopedPtyId, 'ssh-1')
        handlers.clear()
        registerPtyHandlers(
          mainWindow as never,
          undefined,
          undefined,
          undefined,
          undefined,
          store as never
        )

        try {
          await expect(
            handlers.get('pty:spawn')!(null, {
              cols: 80,
              rows: 24,
              env: {},
              connectionId: 'ssh-1',
              sessionId: scopedPtyId
            })
          ).rejects.toThrow(SSH_SESSION_EXPIRED_ERROR)

          expect(store.markSshRemotePtyLease).not.toHaveBeenCalledWith(
            'ssh-1',
            'remote-pty',
            'expired'
          )
          expect(openCodeClearPtyMock).not.toHaveBeenCalledWith(scopedPtyId)
          expect(piClearPtyMock).not.toHaveBeenCalledWith(scopedPtyId)
          getPtyWriteListener()(mainWindowIpcEvent, {
            id: scopedPtyId,
            data: 'echo still-owned'
          })
          expect(remoteWrite).toHaveBeenCalledWith(scopedPtyId, 'echo still-owned')
        } finally {
          deletePtyOwnership(scopedPtyId)
        }
      })
      it('does not tombstone an SSH lease when explicit kill shutdown fails transiently', async () => {
        const store = {
          markSshRemotePtyLease: vi.fn(),
          clearSshRemotePtyKillIntent: vi.fn()
        }
        registerSshPtyProvider('ssh-1', {
          spawn: vi.fn(),
          write: vi.fn(),
          resize: vi.fn(),
          shutdown: vi.fn().mockRejectedValue(new Error('Multiplexer disposed')),
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
        setPtyOwnership('remote-pty', 'ssh-1')
        handlers.clear()
        registerPtyHandlers(
          mainWindow as never,
          undefined,
          undefined,
          undefined,
          undefined,
          store as never
        )

        try {
          await expect(
            handlers.get('pty:kill')!(null, { id: 'remote-pty', keepHistory: false })
          ).rejects.toThrow('Multiplexer disposed')
        } finally {
          deletePtyOwnership('remote-pty')
        }

        expect(store.markSshRemotePtyLease).not.toHaveBeenCalledWith(
          'ssh-1',
          'remote-pty',
          'terminated'
        )
      })
      it('marks an SSH lease terminated after runtime controller kill succeeds', async () => {
        const shutdown = vi.fn(async () => undefined)
        const store = {
          markSshRemotePtyLease: vi.fn(),
          clearSshRemotePtyKillIntent: vi.fn()
        }
        const runtime = {
          setPtyController: vi.fn(),
          onPtyExit: vi.fn()
        }
        registerSshPtyProvider('ssh-1', {
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
        setPtyOwnership('remote-pty', 'ssh-1')
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

        expect(controller.kill('remote-pty')).toBe(true)
        // Why: kill's shutdown runs through the exit-detection wrapper (extra async hops), so one microtask flush isn't enough.
        await new Promise((resolve) => setImmediate(resolve))

        expect(shutdown).toHaveBeenCalledWith('remote-pty', { immediate: false })
        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith(
          'ssh-1',
          'remote-pty',
          'terminated'
        )
        expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', -1, undefined)
      })
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
        ).toEqual([['pty:exit', { id: 'local-pty', code: 0 }]])
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
        ).toEqual([['pty:exit', { id: 'local-pty', code: 0 }]])
      })
      it('classifies host reversible-stop exits for the attached renderer', async () => {
        vi.useFakeTimers()
        const exitListeners = new Set<(payload: { id: string; code: number }) => void>()
        const runtime = {
          setPtyController: vi.fn(),
          onPtyExit: vi.fn()
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
          markReversibleStops: (ptyIds: readonly string[]) => () => void
          stopAndWait: (ptyId: string) => Promise<boolean>
        }
        const release = controller.markReversibleStops(['local-pty'])

        const stopPromise = controller.stopAndWait('local-pty')
        await vi.advanceTimersByTimeAsync(1_200)
        await expect(stopPromise).resolves.toBe(true)
        release()

        expect(
          mainWindow.webContents.send.mock.calls.filter((call) => call[0] === 'pty:exit')
        ).toEqual([['pty:exit', { id: 'local-pty', code: 0, preserveRendererBinding: true }]])
      })
      it('passes keepHistory through runtime controller stopAndWait', async () => {
        vi.useFakeTimers()
        const shutdown = vi.fn(async () => undefined)
        const store = {
          markSshRemotePtyLease: vi.fn(),
          clearSshRemotePtyKillIntent: vi.fn()
        }
        const runtime = {
          setPtyController: vi.fn(),
          onPtyExit: vi.fn()
        }
        registerSshPtyProvider('ssh-1', {
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
        setPtyOwnership('remote-pty', 'ssh-1')
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
          stopAndWait: (ptyId: string, opts?: { keepHistory?: boolean }) => Promise<boolean>
        }

        const stopPromise = controller.stopAndWait('remote-pty', { keepHistory: true })
        await vi.advanceTimersByTimeAsync(1_200)
        await expect(stopPromise).resolves.toBe(true)

        expect(shutdown).toHaveBeenCalledWith('remote-pty', {
          immediate: true,
          keepHistory: true
        })
        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith(
          'ssh-1',
          'remote-pty',
          'terminated'
        )
        expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', 0, undefined)
      })
      it('splits the teardown budget so the liveness RPC gets only what shutdown left', async () => {
        // Why: sequential RPCs must share one absolute deadline; otherwise both get
        // the full ~9.5s bound and their sum overruns the 10s sweep deadline (Finding 1).
        // Fake timers freeze Date.now() at entry, then let the shutdown RPC burn a
        // deterministic slice of the budget so the leaf-observed remainders are provable.
        vi.useFakeTimers()
        // Each provider call records the budget an RPC leaf would see at issue time.
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

        // Both calls carry the same absolute deadline...
        expect(shutdown).toHaveBeenCalledWith(
          'local-pty',
          expect.objectContaining({ immediate: true, deadlineMs })
        )
        // ...so at the leaves the shutdown RPC sees the full 4321ms budget, while the
        // SUBSEQUENT liveness list RPC sees only what shutdown left: the 1000ms it
        // consumed is gone, so 4321 - 1000 = 3321 remain until the shared deadline.
        expect(remainingAtLeaf).toEqual([4321, 3321])
        vi.useRealTimers()
      })
    })
  })
})
