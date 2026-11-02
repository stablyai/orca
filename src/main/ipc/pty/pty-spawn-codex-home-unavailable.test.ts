import { describe, expect, it, vi } from 'vitest'
import { readFileSyncMock, noChatsRuntimeMembers } from './pty-ipc-mock-registry'
import { TEST_CODEX_HOME, TEST_CODEX_AUTH_JSON } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { createDaemonActiveProviderFixtures } from './pty-ipc-daemon-provider-fixtures'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../../codex-accounts/host-codex-managed-home-ownership'
import { registerPtyHandlers } from './register-handlers'
import type { PrepareCodexSessionResume } from './host-env/types'

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

const UNAVAILABLE_MESSAGE = 'Codex account files are temporarily locked. Retry in a moment.'

const MANAGED_ACCOUNT_SETTINGS = (() =>
  ({
    codexManagedAccounts: [
      {
        id: 'account-1',
        managedHomePath: TEST_CODEX_HOME,
        managedHomeRuntime: 'host'
      }
    ]
  }) as never) as () => never

type RuntimeSpawnRequest = { cols: number; rows: number; launchAgent?: 'codex' } & Record<
  string,
  unknown
>
type RuntimeSpawnController = {
  spawn(args: RuntimeSpawnRequest): Promise<{ id: string }>
}

/** Unreadable managed homes must reject with no spawn; null selects the system account and could misattribute the pane (STA-4422). */
describe('registerPtyHandlers Codex launch refusal on an unreadable managed home', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  const { setupDaemonAdapter } = createDaemonActiveProviderFixtures({ handlers, mainWindow })

  function makeRuntime() {
    return {
      setPtyController: vi.fn(),
      ...noChatsRuntimeMembers(),
      createPreAllocatedTerminalHandle: vi.fn(() => null),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
  }

  function register(
    resolveHome: (
      target?: unknown,
      env?: NodeJS.ProcessEnv,
      context?: { unavailableManagedHomePath?: string; launchesCodex?: boolean }
    ) => string | null,
    runtime?: ReturnType<typeof makeRuntime>,
    prepareCodexSessionResume?: PrepareCodexSessionResume
  ): void {
    handlers.clear()
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      resolveHome,
      MANAGED_ACCOUNT_SETTINGS,
      undefined,
      undefined,
      prepareCodexSessionResume ? { prepareCodexSessionResume } : undefined
    )
  }

  const RESUME_SESSION = {
    key: 'session_id' as const,
    id: 'resume-session-1',
    transcriptPath: '/tmp/orca-codex-rollout.jsonl'
  }

  function makeAuthUnreadable(): void {
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath.endsWith('auth.json')) {
        throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
      }
      return ''
    })
  }

  describe('local pty:spawn handler', () => {
    it('spawns with the managed CODEX_HOME when the home reads back cleanly', async () => {
      readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)
      const daemonSpawn = setupDaemonAdapter()
      register(() => TEST_CODEX_HOME)

      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, launchAgent: 'codex' })

      expect(daemonSpawn).toHaveBeenCalledOnce()
      expect(daemonSpawn.mock.calls[0]?.[0].env).toMatchObject({ CODEX_HOME: TEST_CODEX_HOME })
    })

    it('refuses the spawn when the first home resolution is indeterminate', async () => {
      readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)
      const daemonSpawn = setupDaemonAdapter()
      const resolveHome = vi.fn((): string | null => {
        throw new ManagedCodexHomeTemporarilyUnavailableError()
      })
      register(resolveHome)

      await expect(
        handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, launchAgent: 'codex' })
      ).rejects.toThrow(UNAVAILABLE_MESSAGE)

      expect(resolveHome).toHaveBeenCalledOnce()
      expect(daemonSpawn).not.toHaveBeenCalled()
    })

    it('refuses the spawn when the post-auth-wait re-resolution is indeterminate', async () => {
      vi.useFakeTimers()
      makeAuthUnreadable()
      const daemonSpawn = setupDaemonAdapter()
      const resolveHome = vi.fn(
        (
          _target?: unknown,
          _env?: NodeJS.ProcessEnv,
          context?: { unavailableManagedHomePath?: string }
        ): string | null => {
          if (context?.unavailableManagedHomePath) {
            throw new ManagedCodexHomeTemporarilyUnavailableError()
          }
          return TEST_CODEX_HOME
        }
      )
      register(resolveHome)

      const spawnPromise = handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        launchAgent: 'codex'
      })
      const rejection = expect(spawnPromise).rejects.toThrow(UNAVAILABLE_MESSAGE)
      await vi.advanceTimersByTimeAsync(2_000)
      await rejection

      // Prove the initial resolution succeeded before exercising failed re-resolution.
      expect(resolveHome).toHaveBeenCalledTimes(2)
      expect(resolveHome.mock.calls[1]?.[2]).toMatchObject({
        unavailableManagedHomePath: TEST_CODEX_HOME
      })
      expect(daemonSpawn).not.toHaveBeenCalled()
    })

    it('refuses the spawn when the current-selection re-read is indeterminate after auth recovers', async () => {
      vi.useFakeTimers()
      let authReady = false
      readFileSyncMock.mockImplementation((filePath: string) => {
        if (!filePath.endsWith('auth.json')) {
          return ''
        }
        if (!authReady) {
          throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
        }
        return TEST_CODEX_AUTH_JSON
      })
      const daemonSpawn = setupDaemonAdapter()
      const resolveHome = vi.fn((): string | null => {
        if (resolveHome.mock.calls.length > 1) {
          throw new ManagedCodexHomeTemporarilyUnavailableError()
        }
        return TEST_CODEX_HOME
      })
      register(resolveHome)

      const spawnPromise = handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        launchAgent: 'codex'
      })
      const rejection = expect(spawnPromise).rejects.toThrow(UNAVAILABLE_MESSAGE)
      await vi.advanceTimersByTimeAsync(0)
      expect(daemonSpawn).not.toHaveBeenCalled()
      authReady = true
      await vi.advanceTimersByTimeAsync(25)
      await rejection

      expect(resolveHome).toHaveBeenCalledTimes(2)
      expect(daemonSpawn).not.toHaveBeenCalled()
    })

    // Eager resume refusal must propagate; treating it as no resume could launch another account's readable alias (STA-4422).
    it('refuses the spawn when the eager resume gate rejects', async () => {
      readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)
      const daemonSpawn = setupDaemonAdapter()
      register(
        () => TEST_CODEX_HOME,
        undefined,
        () => Promise.reject(new ManagedCodexHomeTemporarilyUnavailableError())
      )

      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          launchAgent: 'codex',
          resumeProviderSession: RESUME_SESSION
        })
      ).rejects.toThrow(UNAVAILABLE_MESSAGE)

      expect(daemonSpawn).not.toHaveBeenCalled()
    })

    it('spawns a resume when the eager resume gate resolves', async () => {
      readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)
      const daemonSpawn = setupDaemonAdapter()
      register(() => TEST_CODEX_HOME, undefined, (() =>
        Promise.resolve(null)) as unknown as () => Promise<never>)

      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        launchAgent: 'codex',
        resumeProviderSession: RESUME_SESSION
      })

      expect(daemonSpawn).toHaveBeenCalledOnce()
    })
  })

  describe('runtime pty controller spawn', () => {
    it('spawns with the managed CODEX_HOME when the home reads back cleanly', async () => {
      readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)
      const daemonSpawn = setupDaemonAdapter()
      const runtime = makeRuntime()
      register(() => TEST_CODEX_HOME, runtime)
      const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

      await controller.spawn({ cols: 80, rows: 24, launchAgent: 'codex' })

      expect(daemonSpawn).toHaveBeenCalledOnce()
      expect(daemonSpawn.mock.calls[0]?.[0].env).toMatchObject({ CODEX_HOME: TEST_CODEX_HOME })
    })

    it('refuses the spawn when the first home resolution is indeterminate', async () => {
      readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)
      const daemonSpawn = setupDaemonAdapter()
      const runtime = makeRuntime()
      const resolveHome = vi.fn((): string | null => {
        throw new ManagedCodexHomeTemporarilyUnavailableError()
      })
      register(resolveHome, runtime)
      const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

      await expect(controller.spawn({ cols: 80, rows: 24, launchAgent: 'codex' })).rejects.toThrow(
        UNAVAILABLE_MESSAGE
      )

      expect(resolveHome).toHaveBeenCalledOnce()
      expect(daemonSpawn).not.toHaveBeenCalled()
    })

    it('refuses the spawn when the post-auth-wait re-resolution is indeterminate', async () => {
      vi.useFakeTimers()
      makeAuthUnreadable()
      const daemonSpawn = setupDaemonAdapter()
      const runtime = makeRuntime()
      const resolveHome = vi.fn(
        (
          _target?: unknown,
          _env?: NodeJS.ProcessEnv,
          context?: { unavailableManagedHomePath?: string }
        ): string | null => {
          if (context?.unavailableManagedHomePath) {
            throw new ManagedCodexHomeTemporarilyUnavailableError()
          }
          return TEST_CODEX_HOME
        }
      )
      register(resolveHome, runtime)
      const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

      const spawnPromise = controller.spawn({ cols: 80, rows: 24, launchAgent: 'codex' })
      const rejection = expect(spawnPromise).rejects.toThrow(UNAVAILABLE_MESSAGE)
      await vi.advanceTimersByTimeAsync(2_000)
      await rejection

      expect(resolveHome).toHaveBeenCalledTimes(2)
      expect(resolveHome.mock.calls[1]?.[2]).toMatchObject({
        unavailableManagedHomePath: TEST_CODEX_HOME
      })
      expect(daemonSpawn).not.toHaveBeenCalled()
    })

    it('refuses the spawn when the eager resume gate rejects', async () => {
      readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)
      const daemonSpawn = setupDaemonAdapter()
      const runtime = makeRuntime()
      register(
        () => TEST_CODEX_HOME,
        runtime,
        () => Promise.reject(new ManagedCodexHomeTemporarilyUnavailableError())
      )
      const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

      await expect(
        controller.spawn({
          cols: 80,
          rows: 24,
          launchAgent: 'codex',
          resumeProviderSession: RESUME_SESSION
        } as never)
      ).rejects.toThrow(UNAVAILABLE_MESSAGE)

      expect(daemonSpawn).not.toHaveBeenCalled()
    })
  })

  // Derived operation IDs are not caller-selected sessions; those fresh launches still await managed login.
  it.each([
    {
      lane: 'host',
      name: 'a create operation',
      request: { worktreeId: 'wt-alpha', agentSessionCreateOperationId: 'a'.repeat(43) },
      waits: true
    },
    {
      lane: 'host',
      name: 'a caller-named session',
      request: { sessionId: 'caller-1' },
      waits: false
    },
    {
      lane: 'window',
      name: 'a caller-named session',
      request: { sessionId: 'caller-1' },
      waits: false
    }
  ] as const)('$lane lane, $name: waits on the managed login: $waits', async (c) => {
    vi.useFakeTimers()
    makeAuthUnreadable()
    const daemonSpawn = setupDaemonAdapter()
    const runtime = makeRuntime()
    register((_target, _env, context) => {
      if (context?.unavailableManagedHomePath) {
        throw new ManagedCodexHomeTemporarilyUnavailableError()
      }
      return TEST_CODEX_HOME
    }, runtime)
    const controller: RuntimeSpawnController = runtime.setPtyController.mock.calls[0]?.[0]
    const request: RuntimeSpawnRequest = { cols: 80, rows: 24, launchAgent: 'codex', ...c.request }

    const spawn = Promise.resolve(
      c.lane === 'host' ? controller.spawn(request) : handlers.get('pty:spawn')!(null, request)
    ).then(
      () => 'spawned',
      (error: Error) => error.message
    )
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(spawn).resolves.toBe(c.waits ? UNAVAILABLE_MESSAGE : 'spawned')
    expect(daemonSpawn).toHaveBeenCalledTimes(c.waits ? 0 : 1)
  })

  // #29209: a host runtime skips resume prep when the launch env names a client-sent CODEX_HOME.
  it.each(['window', 'host', 'window restart'] as const)(
    '%s: resume preserves the request home and selected-account restart',
    async (entry) => {
      const restart = entry === 'window restart'
      readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)
      const daemonSpawn = setupDaemonAdapter()
      const runtime = makeRuntime()
      const sourceHome = `${TEST_CODEX_HOME}-source`
      const prepareResume = vi.fn<PrepareCodexSessionResume>(async (args) => ({
        outcome: 'resume',
        codexHomePath: args.useSelectedAccount ? TEST_CODEX_HOME : sourceHome
      }))
      register(() => TEST_CODEX_HOME, runtime, prepareResume)
      const controller: RuntimeSpawnController = runtime.setPtyController.mock.calls[0]?.[0]
      const request: RuntimeSpawnRequest = {
        cols: 80,
        rows: 24,
        launchAgent: 'codex',
        command: `codex resume ${RESUME_SESSION.id}`,
        resumeProviderSession: RESUME_SESSION,
        ...(restart ? { replacesPtyId: 'old-pty' } : {}),
        env: { CODEX_HOME: '/client/codex-home' }
      }

      await (entry === 'host'
        ? controller.spawn(request)
        : handlers.get('pty:spawn')!(null, request))

      expect(prepareResume.mock.calls[0]?.[0].launchEnv).toMatchObject({
        CODEX_HOME: '/client/codex-home'
      })
      expect(prepareResume.mock.calls[0]?.[0].useSelectedAccount).toBe(restart ? true : undefined)
      expect(daemonSpawn.mock.calls[0]?.[0].env.CODEX_HOME).toBe(
        restart ? TEST_CODEX_HOME : sourceHome
      )
    }
  )

  describe('which spawns launch prep may make wait', () => {
    it('marks a Codex launch, and not a plain terminal, on the local spawn path', async () => {
      readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)
      setupDaemonAdapter()
      const resolveHome = vi.fn(
        (_target?: unknown, _env?: NodeJS.ProcessEnv, _context?: { launchesCodex?: boolean }) =>
          TEST_CODEX_HOME
      )
      register(resolveHome)

      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, launchAgent: 'codex' })
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      const contexts = resolveHome.mock.calls.map(([, , context]) => context)
      expect(contexts[0]).toMatchObject({ launchesCodex: true })
      expect(contexts.at(-1)).toMatchObject({ launchesCodex: false })
    })

    it('marks a Codex launch, and not a plain terminal, on the runtime spawn path', async () => {
      readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)
      setupDaemonAdapter()
      const runtime = makeRuntime()
      const resolveHome = vi.fn(
        (_target?: unknown, _env?: NodeJS.ProcessEnv, _context?: { launchesCodex?: boolean }) =>
          TEST_CODEX_HOME
      )
      register(resolveHome, runtime)
      const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

      await controller.spawn({ cols: 80, rows: 24, launchAgent: 'codex' })
      await controller.spawn({ cols: 80, rows: 24 })

      const contexts = resolveHome.mock.calls.map(([, , context]) => context)
      expect(contexts[0]).toMatchObject({ launchesCodex: true })
      expect(contexts.at(-1)).toMatchObject({ launchesCodex: false })
    })
  })
})
