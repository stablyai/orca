import { describe, expect, it, vi } from 'vitest'
import {
  readFileSyncMock,
  openCodeBuildPtyEnvMock,
  piBuildPtyEnvMock
} from './pty-ipc-mock-registry'
import {
  expectedOmpStatusExtension,
  TEST_CODEX_HOME,
  TEST_CODEX_AUTH_JSON
} from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { createDaemonActiveProviderFixtures } from './pty-ipc-daemon-provider-fixtures'
import { join } from 'node:path'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
import { registerPtyHandlers, resolveCodexHomeAfterManagedAuthReadiness } from './pty'

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
      const { setupDaemonAdapter, daemonSpawnAndGetEnv } = createDaemonActiveProviderFixtures({
        handlers,
        mainWindow
      })

      // Why: under the daemon, LocalPtyProvider.buildSpawnEnv never runs, so host-local env injection must happen in the pty:spawn handler instead.
      it('waits for managed Codex auth before spawning a daemon PTY', async () => {
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
        handlers.clear()
        registerPtyHandlers(mainWindow as never, undefined, () => TEST_CODEX_HOME, (() => ({
          codexManagedAccounts: [
            {
              id: 'account-1',
              managedHomePath: TEST_CODEX_HOME,
              managedHomeRuntime: 'host'
            }
          ]
        })) as never)

        const spawnPromise = handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          launchAgent: 'codex'
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(daemonSpawn).not.toHaveBeenCalled()

        authReady = true
        await vi.advanceTimersByTimeAsync(25)
        await spawnPromise

        expect(daemonSpawn.mock.calls.at(-1)?.[0].env).toMatchObject({
          CODEX_HOME: TEST_CODEX_HOME,
          ORCA_CODEX_HOME: TEST_CODEX_HOME
        })
      })
      it('resolves valid managed Codex auth synchronously', () => {
        readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)
        const resolveCurrent = vi.fn(() => TEST_CODEX_HOME)
        const resolveAfterUnavailable = vi.fn(() => null)
        const settings = {
          codexManagedAccounts: [
            {
              id: 'account-1',
              managedHomePath: TEST_CODEX_HOME,
              managedHomeRuntime: 'host'
            }
          ]
        }

        const resolution = resolveCodexHomeAfterManagedAuthReadiness({
          selectedCodexHomePath: TEST_CODEX_HOME,
          getSettings: () => settings as never,
          target: { runtime: 'host' },
          resolveCurrent,
          resolveAfterUnavailable
        })

        expect(resolution).toBe(TEST_CODEX_HOME)
        expect(resolveCurrent).not.toHaveBeenCalled()
        expect(resolveAfterUnavailable).not.toHaveBeenCalled()
      })
      it('uses the current account when the original auth recovers after a switch', async () => {
        vi.useFakeTimers()
        const nextHome = '/managed/next/home'
        let originalAuthReady = false
        let selectedHome = TEST_CODEX_HOME
        readFileSyncMock.mockImplementation((filePath: string) => {
          if (filePath === join(TEST_CODEX_HOME, 'auth.json') && !originalAuthReady) {
            throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
          }
          if (filePath.endsWith('auth.json')) {
            return TEST_CODEX_AUTH_JSON
          }
          return ''
        })
        const daemonSpawn = setupDaemonAdapter()
        const resolveHome = vi.fn(() => selectedHome)
        handlers.clear()
        registerPtyHandlers(mainWindow as never, undefined, resolveHome, (() => ({
          codexManagedAccounts: [TEST_CODEX_HOME, nextHome].map((managedHomePath, index) => ({
            id: `account-${index + 1}`,
            managedHomePath,
            managedHomeRuntime: 'host'
          }))
        })) as never)

        const spawnPromise = handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          launchAgent: 'codex'
        })
        await vi.advanceTimersByTimeAsync(0)
        selectedHome = nextHome
        originalAuthReady = true
        await vi.advanceTimersByTimeAsync(25)
        await spawnPromise

        expect(resolveHome).toHaveBeenCalledTimes(2)
        expect(daemonSpawn.mock.calls[0]?.[0].env).toMatchObject({
          CODEX_HOME: nextHome,
          ORCA_CODEX_HOME: nextHome
        })
      })
      it('does not gate a non-Codex daemon PTY on managed Codex auth', async () => {
        readFileSyncMock.mockImplementation((filePath: string) => {
          if (filePath.endsWith('auth.json')) {
            throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
          }
          return ''
        })
        const daemonSpawn = setupDaemonAdapter()
        handlers.clear()
        registerPtyHandlers(mainWindow as never, undefined, () => TEST_CODEX_HOME, (() => ({
          codexManagedAccounts: [
            {
              id: 'account-1',
              managedHomePath: TEST_CODEX_HOME,
              managedHomeRuntime: 'host'
            }
          ]
        })) as never)

        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          launchAgent: 'claude'
        })

        expect(daemonSpawn).toHaveBeenCalledOnce()
      })
      it('does not gate a Codex daemon reattach on current managed auth', async () => {
        readFileSyncMock.mockImplementation((filePath: string) => {
          if (filePath.endsWith('auth.json')) {
            throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
          }
          return ''
        })
        const daemonSpawn = setupDaemonAdapter()
        handlers.clear()
        registerPtyHandlers(mainWindow as never, undefined, () => TEST_CODEX_HOME, (() => ({
          codexManagedAccounts: [
            {
              id: 'account-1',
              managedHomePath: TEST_CODEX_HOME,
              managedHomeRuntime: 'host'
            }
          ]
        })) as never)

        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          launchAgent: 'codex',
          sessionId: 'retained-codex'
        })

        expect(daemonSpawn).toHaveBeenCalledOnce()
      })
      it('does not gate a runtime-created Codex reattach on current managed auth', async () => {
        type RuntimeSpawnController = {
          spawn(args: {
            cols: number
            rows: number
            launchAgent: 'codex'
            sessionId: string
          }): Promise<{ id: string }>
        }
        readFileSyncMock.mockImplementation((filePath: string) => {
          if (filePath.endsWith('auth.json')) {
            throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
          }
          return ''
        })
        const daemonSpawn = setupDaemonAdapter()
        const runtime = {
          setPtyController: vi.fn(),
          registerPty: vi.fn(),
          noteTerminalSpawnCommand: vi.fn(),
          onPtySpawned: vi.fn(),
          onPtyExit: vi.fn(),
          onPtyData: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never, () => TEST_CODEX_HOME, (() => ({
          codexManagedAccounts: [
            {
              id: 'account-1',
              managedHomePath: TEST_CODEX_HOME,
              managedHomeRuntime: 'host'
            }
          ]
        })) as never)
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

        await controller.spawn({
          cols: 80,
          rows: 24,
          launchAgent: 'codex',
          sessionId: 'retained-runtime-codex'
        })

        expect(daemonSpawn).toHaveBeenCalledOnce()
      })
      it('falls back when managed Codex auth stays unavailable', async () => {
        vi.useFakeTimers()
        readFileSyncMock.mockImplementation((filePath: string) => {
          if (filePath.endsWith('auth.json')) {
            throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
          }
          return ''
        })
        const daemonSpawn = setupDaemonAdapter()
        const resolveHome = vi.fn(
          (
            _target?: unknown,
            _env?: NodeJS.ProcessEnv,
            context?: { unavailableManagedHomePath?: string }
          ) => (context?.unavailableManagedHomePath ? null : TEST_CODEX_HOME)
        )
        handlers.clear()
        registerPtyHandlers(mainWindow as never, undefined, resolveHome, (() => ({
          codexManagedAccounts: [
            {
              id: 'account-1',
              managedHomePath: TEST_CODEX_HOME,
              managedHomeRuntime: 'host'
            }
          ]
        })) as never)

        const spawnPromise = handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          launchAgent: 'codex'
        })
        await vi.advanceTimersByTimeAsync(2_000)
        await spawnPromise

        expect(resolveHome).toHaveBeenCalledTimes(2)
        expect(resolveHome.mock.calls[1]?.[2]).toMatchObject({
          unavailableManagedHomePath: TEST_CODEX_HOME
        })
        expect(daemonSpawn).toHaveBeenCalledOnce()
        expect(daemonSpawn.mock.calls[0]?.[0].env).not.toHaveProperty('CODEX_HOME')
      })
      it('rejects when account changes keep resolving unavailable managed homes', async () => {
        vi.useFakeTimers()
        const secondHome = '/managed/second/home'
        const thirdHome = '/managed/third/home'
        readFileSyncMock.mockImplementation((filePath: string) => {
          if (filePath.endsWith('auth.json')) {
            throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
          }
          return ''
        })
        const daemonSpawn = setupDaemonAdapter()
        const resolveHome = vi.fn(
          (
            _target?: unknown,
            _env?: NodeJS.ProcessEnv,
            context?: { unavailableManagedHomePath?: string }
          ) =>
            !context?.unavailableManagedHomePath
              ? TEST_CODEX_HOME
              : context.unavailableManagedHomePath === TEST_CODEX_HOME
                ? secondHome
                : thirdHome
        )
        handlers.clear()
        registerPtyHandlers(mainWindow as never, undefined, resolveHome, (() => ({
          codexManagedAccounts: [TEST_CODEX_HOME, secondHome, thirdHome].map(
            (managedHomePath, index) => ({
              id: `account-${index + 1}`,
              managedHomePath,
              managedHomeRuntime: 'host'
            })
          )
        })) as never)

        const spawnPromise = handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          launchAgent: 'codex'
        })
        const rejection = expect(spawnPromise).rejects.toThrow(
          'The selected Codex account credentials are temporarily unavailable. Try opening the terminal again.'
        )
        await vi.advanceTimersByTimeAsync(4_000)
        await rejection

        expect(resolveHome.mock.calls.map((call) => call[2]?.unavailableManagedHomePath)).toEqual([
          undefined,
          TEST_CODEX_HOME,
          secondHome
        ])
        expect(vi.getTimerCount()).toBe(0)
        expect(daemonSpawn).not.toHaveBeenCalled()
      })
      it('falls back for a runtime-created Codex launch when auth stays unavailable', async () => {
        type RuntimeSpawnController = {
          spawn(args: { cols: number; rows: number; launchAgent: 'codex' }): Promise<{ id: string }>
        }
        vi.useFakeTimers()
        readFileSyncMock.mockImplementation((filePath: string) => {
          if (filePath.endsWith('auth.json')) {
            throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
          }
          return ''
        })
        const daemonSpawn = setupDaemonAdapter()
        const resolveHome = vi.fn(
          (
            _target?: unknown,
            _env?: NodeJS.ProcessEnv,
            context?: { unavailableManagedHomePath?: string }
          ) => (context?.unavailableManagedHomePath ? null : TEST_CODEX_HOME)
        )
        const runtime = {
          setPtyController: vi.fn(),
          registerPty: vi.fn(),
          noteTerminalSpawnCommand: vi.fn(),
          onPtySpawned: vi.fn(),
          onPtyExit: vi.fn(),
          onPtyData: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never, resolveHome, (() => ({
          codexManagedAccounts: [
            {
              id: 'account-1',
              managedHomePath: TEST_CODEX_HOME,
              managedHomeRuntime: 'host'
            }
          ]
        })) as never)
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

        const spawnPromise = controller.spawn({ cols: 80, rows: 24, launchAgent: 'codex' })
        await vi.advanceTimersByTimeAsync(0)
        expect(daemonSpawn).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(2_000)
        await spawnPromise

        expect(resolveHome).toHaveBeenCalledTimes(2)
        expect(resolveHome.mock.calls[1]?.[2]).toMatchObject({
          unavailableManagedHomePath: TEST_CODEX_HOME
        })
        expect(daemonSpawn).toHaveBeenCalledOnce()
        expect(daemonSpawn.mock.calls[0]?.[0].env).not.toHaveProperty('CODEX_HOME')
      })
      it('injects OpenCode plugin env (OPENCODE_CONFIG_DIR) on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({}, undefined, undefined, {
          OPENCODE_CONFIG_DIR: undefined
        })
        expect(openCodeBuildPtyEnvMock).toHaveBeenCalled()
        expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-config')
        expect(env.ORCA_OPENCODE_HOOK_PORT).toBe('4567')
      })
      it('mirrors a user-provided OPENCODE_CONFIG_DIR into a source-scoped overlay on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({ OPENCODE_CONFIG_DIR: '/user/custom/opencode' })
        // Why: OpenCode loads config from a single dir, so the user's path is mirrored into a source-scoped overlay, not passed through.
        expect(openCodeBuildPtyEnvMock).toHaveBeenCalledWith(
          expect.any(String),
          '/user/custom/opencode'
        )
        expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
        expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
        expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe('/user/custom/opencode')
      })
      it('uses source OpenCode config env instead of remirroring a parent overlay', async () => {
        const env = await daemonSpawnAndGetEnv({
          OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay',
          ORCA_OPENCODE_SOURCE_CONFIG_DIR: '/user/custom/opencode'
        })
        expect(openCodeBuildPtyEnvMock).toHaveBeenCalledWith(
          expect.any(String),
          '/user/custom/opencode'
        )
        expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
        expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
        expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe('/user/custom/opencode')
      })
      it('installs Pi managed extensions without redirecting homes on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({ PI_CODING_AGENT_DIR: '/user/.pi/agent' })
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
          expect.any(String),
          '/user/.pi/agent',
          'pi',
          {
            materializeDefaultHome: false
          }
        )
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'omp', {
          materializeDefaultHome: false
        })
        expect(env.PI_CODING_AGENT_DIR).toBe('/user/.pi/agent')
        expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/user/.pi/agent')
        expect(env.ORCA_OMP_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(expectedOmpStatusExtension)
      })
      it('does not materialize agent homes when another daemon agent mentions OMP', async () => {
        const env = await daemonSpawnAndGetEnv(undefined, undefined, undefined, undefined, {
          command: 'codex "ask about omp"',
          launchAgent: 'codex'
        })

        expect(piBuildPtyEnvMock).toHaveBeenCalledTimes(1)
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'pi', {
          materializeDefaultHome: false
        })
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
      })
      it('threads command: "omp" through to piBuildPtyEnv on the daemon path with OMP status metadata', async () => {
        // Why: mirror of the local-spawn OMP threading assertion; the daemon path's `command` forwarding could silently regress otherwise.
        const env = await daemonSpawnAndGetEnv(
          { PI_CODING_AGENT_DIR: '/user/.omp/agent' },
          undefined,
          undefined,
          undefined,
          { command: 'omp' }
        )
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
          expect.any(String),
          '/user/.omp/agent',
          'omp',
          { materializeDefaultHome: true }
        )
        expect(env.PI_CODING_AGENT_DIR).toBe('/user/.omp/agent')
        expect(env.ORCA_OMP_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(
          '/user/.omp/agent/extensions/orca-agent-status.ts'
        )
        expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBe('/user/.omp/agent')
        expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
      })
      it('uses sequenced startup env as the daemon OMP launch hint when command is a wrapper', async () => {
        const env = await daemonSpawnAndGetEnv(
          {
            PI_CODING_AGENT_DIR: '/user/.omp/agent',
            [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'omp --resume'
          },
          undefined,
          undefined,
          undefined,
          { command: 'powershell wait-wrapper' }
        )

        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
          expect.any(String),
          '/user/.omp/agent',
          'omp',
          { materializeDefaultHome: true }
        )
        expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(
          '/user/.omp/agent/extensions/orca-agent-status.ts'
        )
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
      })
      it('injects the selected Codex home on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({}, () => TEST_CODEX_HOME)
        expect(env.CODEX_HOME).toBe(TEST_CODEX_HOME)
        expect(env.ORCA_CODEX_HOME).toBe(TEST_CODEX_HOME)
      })
    })
  })
})
