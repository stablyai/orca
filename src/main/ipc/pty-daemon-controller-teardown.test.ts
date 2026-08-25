import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { makePaneKey } from '../../shared/stable-pane-id'
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
  const { handlers, mainWindow } = setupPtyIpcSuite()

  describe('spawn environment', () => {
    describe('daemon-active provider (parity with LocalPtyProvider)', () => {
      // Why: under the daemon, LocalPtyProvider.buildSpawnEnv never runs, so host-local env injection must happen in the pty:spawn handler instead.
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
      it('runtime controller kill routes app-scoped SSH ids through the parsed provider when ownership is absent', async () => {
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
        const shutdown = vi.fn(async () => undefined)
        const store = { markSshRemotePtyLease: vi.fn() }
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

        expect(controller.kill('ssh:ssh-1@@relay-pty')).toBe(true)
        await new Promise((resolve) => setImmediate(resolve))

        expect(shutdown).toHaveBeenCalledWith('ssh:ssh-1@@relay-pty', { immediate: false })
        expect(localShutdown).not.toHaveBeenCalled()
        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'relay-pty', 'terminated')
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

        // The lease is tombstoned, but nothing observed the detached relay PTY
        // stop, so the stop itself is reported as unconfirmed.
        expect(controller.kill('ssh:ssh-1@@relay-pty')).toBe(false)

        expect(localShutdown).not.toHaveBeenCalled()
        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'relay-pty', 'terminated')
        expect(runtime.onPtyExit).toHaveBeenCalledWith('ssh:ssh-1@@relay-pty', -1, undefined)
      })
      it('marks a detached SSH lease terminated when runtime controller kill has no provider', async () => {
        const store = {
          markSshRemotePtyLease: vi.fn()
        }
        const runtime = {
          setPtyController: vi.fn(),
          onPtyExit: vi.fn()
        }
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

        expect(controller.kill('remote-pty')).toBe(false)

        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith(
          'ssh-1',
          'remote-pty',
          'terminated'
        )
        expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', -1, undefined)
      })
      it('keeps a rejected SSH PTY unverifiable after kill shutdown fails transiently', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const store = {
          markSshRemotePtyLease: vi.fn()
        }
        const runtime = {
          setPtyController: vi.fn(),
          onPtyExit: vi.fn(),
          markPtyLivenessUnverifiable: vi.fn()
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
          runtime as never,
          undefined,
          undefined,
          undefined,
          store as never
        )
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          kill: (ptyId: string) => boolean
          retireRejectedPty: (ptyId: string, stopConfirmed: boolean) => void
        }

        try {
          expect(controller.kill('remote-pty')).toBe(true)
          await new Promise((resolve) => setImmediate(resolve))
          expect(store.markSshRemotePtyLease).not.toHaveBeenCalledWith(
            'ssh-1',
            'remote-pty',
            'terminated'
          )
          controller.retireRejectedPty('remote-pty', false)
        } finally {
          warnSpy.mockRestore()
          deletePtyOwnership('remote-pty')
        }

        expect(store.markSshRemotePtyLease).not.toHaveBeenCalledWith(
          'ssh-1',
          'remote-pty',
          'terminated'
        )
        expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
          'remote-pty',
          'a follow-up stop was issued but its outcome could not be verified'
        )
        expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', -1, undefined)
        expect(runtime.onPtyExit).not.toHaveBeenCalledWith('remote-pty', 0, undefined)
      })
      it('strips ORCA_PANE_KEY/TAB_ID/WORKTREE_ID from SSH spawn env when remote agent hooks are disabled', async () => {
        const sshSpawn = vi.fn(async (_opts: { env: Record<string, string> }) => ({
          id: 'ssh-pty'
        }))
        registerSshPtyProvider('ssh-1', {
          spawn: sshSpawn,
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
        handlers.clear()
        registerPtyHandlers(mainWindow as never)
        const prevFlag = process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
        process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '0'
        try {
          await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            env: {
              FOO: 'bar',
              ORCA_PANE_KEY: 'tab-1:0',
              ORCA_TAB_ID: 'tab-1',
              ORCA_WORKTREE_ID: 'wt-1'
            },
            connectionId: 'ssh-1'
          })
          const env = sshSpawn.mock.calls.at(-1)![0].env
          expect(env.FOO).toBe('bar')
          expect(env.ORCA_PANE_KEY).toBeUndefined()
          expect(env.ORCA_TAB_ID).toBeUndefined()
          expect(env.ORCA_WORKTREE_ID).toBeUndefined()
          expect(env.ORCA_AGENT_HOOK_TOKEN).toBeUndefined()
          // Why: the local hook server's userData-relative endpoint path is meaningless on the remote box; assert no leak.
          expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
        } finally {
          if (prevFlag === undefined) {
            delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
          } else {
            process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = prevFlag
          }
        }
      })
      it('forwards ORCA_PANE_KEY/TAB_ID/WORKTREE_ID over SSH by default', async () => {
        const sshSpawn = vi.fn(async (_opts: { env: Record<string, string> }) => ({
          id: 'ssh-pty'
        }))
        registerSshPtyProvider('ssh-1', {
          spawn: sshSpawn,
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
        handlers.clear()
        registerPtyHandlers(mainWindow as never)
        const prevFlag = process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
        delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
        try {
          const leafId = '22222222-2222-4222-8222-222222222222'
          const paneKey = makePaneKey('tab-2', leafId)
          await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            env: {
              FOO: 'bar',
              ORCA_PANE_KEY: paneKey,
              ORCA_TAB_ID: 'tab-2',
              ORCA_WORKTREE_ID: 'wt-2'
            },
            connectionId: 'ssh-1',
            tabId: 'tab-2',
            leafId
          })
          const env = sshSpawn.mock.calls.at(-1)![0].env
          expect(env.ORCA_PANE_KEY).toBe(paneKey)
          expect(env.ORCA_TAB_ID).toBe('tab-2')
          expect(env.ORCA_WORKTREE_ID).toBe('wt-2')
          // Local hook server coords must NOT cross the wire — the relay is the source of truth.
          expect(env.ORCA_AGENT_HOOK_TOKEN).toBeUndefined()
          expect(env.ORCA_AGENT_HOOK_PORT).toBeUndefined()
          expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
        } finally {
          if (prevFlag === undefined) {
            delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
          } else {
            process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = prevFlag
          }
        }
      })
    })
  })
})
