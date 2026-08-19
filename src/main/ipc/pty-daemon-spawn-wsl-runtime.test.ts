import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  type DaemonSpawnCall,
  createDaemonActiveProviderFixtures
} from './pty-ipc-daemon-provider-fixtures'
import { delimiter, join } from 'node:path'
import { _setWslCachesForTests } from '../wsl'
import { registerPtyHandlers } from './pty'

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
      const {
        setupDaemonAdapter,
        withWin32Platform,
        makeProjectRuntimeStore,
        daemonSpawnAndGetOptions,
        daemonSpawnAndGetEnv
      } = createDaemonActiveProviderFixtures({ handlers, mainWindow })

      // Why: under the daemon, LocalPtyProvider.buildSpawnEnv never runs, so host-local env injection must happen in the pty:spawn handler instead.
      it('strips inherited Claude child-session stamps from a local runtime-created PTY', async () => {
        // Why: the runtime strip is deliberately not gated on isDaemonHostSpawn, so
        // the local provider — which spreads main's own process.env — needs its own
        // case; a daemon-only test would still pass if someone added that gate.
        type RuntimeSpawnController = {
          spawn(args: {
            cols: number
            rows: number
            worktreeId?: string
            env?: Record<string, string>
          }): Promise<{ id: string }>
        }
        const runtime = {
          setPtyController: vi.fn(),
          registerPty: vi.fn(),
          noteTerminalSpawnCommand: vi.fn(),
          onPtySpawned: vi.fn(),
          onPtyExit: vi.fn(),
          onPtyData: vi.fn(),
          preAllocateHandleForPty: vi.fn(() => 'handle-runtime-local')
        }
        const saved = process.env.CLAUDE_CODE_CHILD_SESSION
        process.env.CLAUDE_CODE_CHILD_SESSION = '1'
        try {
          handlers.clear()
          registerPtyHandlers(mainWindow as never, runtime as never)
          const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

          await controller.spawn({ cols: 80, rows: 24, env: {} })

          const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
          expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
        } finally {
          if (saved === undefined) {
            delete process.env.CLAUDE_CODE_CHILD_SESSION
          } else {
            process.env.CLAUDE_CODE_CHILD_SESSION = saved
          }
        }
      })
      it('threads the validated pane identity into registerPty for a runtime-created daemon PTY (#7587)', async () => {
        type RuntimeSpawnController = {
          spawn(args: {
            cols: number
            rows: number
            worktreeId?: string
            tabId?: string
            leafId?: string
            env?: Record<string, string>
          }): Promise<{ id: string }>
        }
        const leafId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        setupDaemonAdapter()
        const runtime = {
          setPtyController: vi.fn(),
          registerPty: vi.fn(),
          onPtySpawned: vi.fn(),
          onPtyExit: vi.fn(),
          onPtyData: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

        await controller.spawn({
          cols: 80,
          rows: 24,
          worktreeId: 'wt-runtime',
          tabId: 'tab-1',
          leafId
        })

        // Why: runtime-created spawns must thread {tabId, leafId} so the catch-path rescue can keep their live PTY (#7587).
        expect(runtime.registerPty).toHaveBeenCalledWith(
          expect.any(String),
          'wt-runtime',
          null,
          { tabId: 'tab-1', leafId },
          false
        )
      })
      it('uses the owning project WSL runtime for runtime-created daemon PTYs', async () => {
        await withWin32Platform(async () => {
          _setWslCachesForTests({ available: true, distros: ['Ubuntu'] })
          const daemonSpawn = setupDaemonAdapter()
          const runtime = {
            setPtyController: vi.fn(),
            registerPty: vi.fn(),
            onPtySpawned: vi.fn(),
            onPtyExit: vi.fn(),
            onPtyData: vi.fn()
          }
          const settings = {
            localWindowsRuntimeDefault: { kind: 'windows-host' },
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsWslDistro: 'Debian',
            terminalWindowsPowerShellImplementation: 'auto'
          }
          const store = makeProjectRuntimeStore({
            projectRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
            settings
          })
          handlers.clear()
          registerPtyHandlers(
            mainWindow as never,
            runtime as never,
            undefined,
            (() => settings) as never,
            undefined,
            store as never
          )
          const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
            spawn(args: {
              cols: number
              rows: number
              cwd?: string
              worktreeId?: string
              env?: Record<string, string>
            }): Promise<{ id: string }>
          }

          await controller.spawn({
            cols: 80,
            rows: 24,
            cwd: 'C:\\repo',
            worktreeId: 'repo-1::C:\\repo',
            env: {}
          })

          const spawnOptions = daemonSpawn.mock.calls.at(-1)?.[0] as DaemonSpawnCall
          expect(spawnOptions.shellOverride).toBe('wsl.exe')
          expect(spawnOptions.terminalWindowsWslDistro).toBe('Ubuntu')
          expect(spawnOptions.terminalWindowsPowerShellImplementation).toBe('auto')
          expect(runtime.registerPty).toHaveBeenCalledWith(
            expect.any(String),
            'repo-1::C:\\repo',
            null,
            undefined,
            true
          )
        })
      })
      it('resolves default WSL authority before daemon host env and spawn metadata', async () => {
        await withWin32Platform(async () => {
          _setWslCachesForTests({ available: true, distros: ['Ubuntu'] })
          const daemonSpawn = setupDaemonAdapter()
          const runtime = {
            setPtyController: vi.fn(),
            registerPty: vi.fn(),
            onPtySpawned: vi.fn(),
            onPtyExit: vi.fn(),
            onPtyData: vi.fn(),
            preparePtyExecutionContext: vi.fn().mockReturnValue(true),
            getOrchestrationCompatibilityHostId: vi.fn(() => 'compat-host')
          }
          const settings = {
            terminalWindowsShell: 'wsl.exe',
            terminalWindowsWslDistro: null,
            terminalWindowsPowerShellImplementation: 'auto'
          }
          handlers.clear()
          registerPtyHandlers(
            mainWindow as never,
            runtime as never,
            undefined,
            (() => settings) as never
          )
          const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
            spawn(args: {
              cols: number
              rows: number
              cwd?: string
              worktreeId?: string
              env?: Record<string, string>
            }): Promise<{ id: string }>
          }

          await controller.spawn({
            cols: 80,
            rows: 24,
            cwd: 'C:\\repo',
            worktreeId: 'repo-1::C:\\repo',
            env: {}
          })

          const spawnOptions = daemonSpawn.mock.calls.at(-1)?.[0] as DaemonSpawnCall
          expect(spawnOptions.terminalWindowsWslDistro).toBe('Ubuntu')
          expect(spawnOptions.env).toMatchObject({
            ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'wsl',
            ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'compat-host',
            ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'Ubuntu'
          })
          expect(runtime.preparePtyExecutionContext).toHaveBeenCalledWith(
            expect.any(String),
            'Ubuntu',
            expect.objectContaining({ resetIncarnation: true })
          )
        })
      })
      it('distinguishes an attached native context from an older daemon fallback', async () => {
        await withWin32Platform(async () => {
          _setWslCachesForTests({ available: true, distros: ['Ubuntu'] })
          const settings = {
            localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
            terminalWindowsShell: 'wsl.exe',
            terminalWindowsWslDistro: 'Ubuntu',
            terminalWindowsPowerShellImplementation: 'auto'
          }
          const cases: {
            reportedWslDistro: string | null | undefined
            expectedWslDistro: string | null
            sessionId: string
          }[] = [
            {
              reportedWslDistro: null,
              expectedWslDistro: null,
              sessionId: 'native-session'
            },
            {
              reportedWslDistro: undefined,
              expectedWslDistro: 'Ubuntu',
              sessionId: 'older-daemon-session'
            }
          ]

          for (const testCase of cases) {
            setupDaemonAdapter(true, testCase.reportedWslDistro)
            const runtime = {
              setPtyController: vi.fn(),
              createPreAllocatedTerminalHandle: vi.fn(() => null),
              preAllocateHandleForPty: vi.fn(),
              registerPty: vi.fn(),
              onPtySpawned: vi.fn(),
              onPtyExit: vi.fn(),
              onPtyData: vi.fn(),
              preparePtyExecutionContext: vi.fn().mockReturnValue(true)
            }
            handlers.clear()
            registerPtyHandlers(
              mainWindow as never,
              runtime as never,
              undefined,
              (() => settings) as never
            )

            await handlers.get('pty:spawn')!(null, {
              cols: 80,
              rows: 24,
              sessionId: testCase.sessionId,
              cwd: '\\\\server\\share\\repo'
            })

            expect(runtime.preparePtyExecutionContext).toHaveBeenLastCalledWith(
              testCase.sessionId,
              testCase.expectedWslDistro
            )
          }
        })
      })
      it('blocks runtime-created daemon PTYs when project WSL runtime requires repair', async () => {
        await withWin32Platform(async () => {
          _setWslCachesForTests({ available: true, distros: ['Debian'] })
          const daemonSpawn = setupDaemonAdapter()
          const runtime = {
            setPtyController: vi.fn(),
            registerPty: vi.fn(),
            onPtySpawned: vi.fn(),
            onPtyExit: vi.fn(),
            onPtyData: vi.fn()
          }
          const settings = {
            localWindowsRuntimeDefault: { kind: 'windows-host' },
            terminalWindowsShell: 'powershell.exe'
          }
          const store = makeProjectRuntimeStore({
            projectRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
            settings
          })
          handlers.clear()
          registerPtyHandlers(
            mainWindow as never,
            runtime as never,
            undefined,
            (() => settings) as never,
            undefined,
            store as never
          )
          const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
            spawn(args: {
              cols: number
              rows: number
              cwd?: string
              worktreeId?: string
              env?: Record<string, string>
            }): Promise<{ id: string }>
          }

          await expect(
            controller.spawn({
              cols: 80,
              rows: 24,
              cwd: 'C:\\repo',
              worktreeId: 'repo-1::C:\\repo',
              env: {}
            })
          ).rejects.toThrow(
            'Project runtime requires repair before terminal spawn: wsl-distro-missing'
          )
          expect(daemonSpawn).not.toHaveBeenCalled()
        })
      })
      it('keeps the Agent Teams tmux shim ahead of host PATH shims for runtime-created daemon PTYs', async () => {
        type RuntimeSpawnController = {
          spawn(args: {
            cols: number
            rows: number
            worktreeId?: string
            env?: Record<string, string>
            envToDelete?: string[]
            command?: string
          }): Promise<{ id: string }>
        }
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
        registerPtyHandlers(mainWindow as never, runtime as never)
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

        // Why: dev mode makes buildPtyHostEnv prepend its own CLI shim on every platform, so
        // the promotion below has something to beat instead of passing trivially.
        const { app } = await import('electron')
        const mockedApp = app as unknown as { isPackaged: boolean }
        const prevPackaged = mockedApp.isPackaged
        mockedApp.isPackaged = false
        try {
          await controller.spawn({
            cols: 80,
            rows: 24,
            worktreeId: 'wt-runtime',
            command: 'claude',
            env: {
              PATH: `/tmp/orca-agent-teams-bin${delimiter}/usr/bin`,
              ORCA_AGENT_TEAMS_TEAM_ID: 'team-test',
              TERM_PROGRAM: 'Orca'
            },
            envToDelete: ['TERM_PROGRAM']
          })
        } finally {
          mockedApp.isPackaged = prevPackaged
        }

        const spawnOptions = daemonSpawn.mock.calls.at(-1)?.[0] as DaemonSpawnCall
        const spawnedPath = spawnOptions.env.PATH.split(delimiter)
        expect(spawnedPath[0]).toBe('/tmp/orca-agent-teams-bin')
        expect(spawnedPath.some((entry) => entry.includes(join('cli', 'bin')))).toBe(true)
        expect(spawnOptions.env.TERM_PROGRAM).toBeUndefined()
        expect(spawnOptions.envToDelete).toEqual(expect.arrayContaining(['TERM_PROGRAM']))
      })
      it('strips inherited agent-hook endpoint env from development daemon PTYs', async () => {
        const { app } = await import('electron')
        const mockedApp = app as unknown as { isPackaged: boolean }
        const prev = mockedApp.isPackaged
        mockedApp.isPackaged = false
        try {
          const env = await daemonSpawnAndGetEnv({}, undefined, undefined, {
            ORCA_AGENT_HOOK_ENDPOINT: '/tmp/stale-endpoint.env'
          })
          expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
          expect(env.ORCA_AGENT_HOOK_PORT).toBe('5678')
          expect(env.ORCA_AGENT_HOOK_TOKEN).toBe('agent-token')
        } finally {
          mockedApp.isPackaged = prev
        }
      })
      it('keeps the Agent Teams tmux shim ahead of host PATH shims on daemon pty:spawn', async () => {
        // Why: dev mode makes buildPtyHostEnv prepend its own CLI shim on every platform, so
        // the promotion below has something to beat instead of passing trivially.
        const { app } = await import('electron')
        const mockedApp = app as unknown as { isPackaged: boolean }
        const prevPackaged = mockedApp.isPackaged
        mockedApp.isPackaged = false
        let spawnOptions: Awaited<ReturnType<typeof daemonSpawnAndGetOptions>>
        try {
          spawnOptions = await daemonSpawnAndGetOptions(
            {
              PATH: `/tmp/orca-agent-teams-bin${delimiter}/usr/bin`,
              ORCA_AGENT_TEAMS_TEAM_ID: 'team-test',
              TERM_PROGRAM: 'Orca'
            },
            undefined,
            undefined,
            undefined,
            {
              command: 'claude',
              envToDelete: ['TERM_PROGRAM']
            }
          )
        } finally {
          mockedApp.isPackaged = prevPackaged
        }

        const spawnedPath = spawnOptions.env.PATH.split(delimiter)
        expect(spawnedPath[0]).toBe('/tmp/orca-agent-teams-bin')
        expect(spawnedPath.some((entry) => entry.includes(join('cli', 'bin')))).toBe(true)
        expect(spawnOptions.env.TERM_PROGRAM).toBeUndefined()
        expect(spawnOptions.envToDelete).toEqual(expect.arrayContaining(['TERM_PROGRAM']))
      })
      it('injects dev-mode ORCA_USER_DATA_PATH + dev CLI PATH on the daemon path', async () => {
        // Why: the mocked `app` is a plain object, so we can flip isPackaged for the test's scope.
        const { app } = await import('electron')
        const mockedApp = app as unknown as { isPackaged: boolean }
        const prev = mockedApp.isPackaged
        mockedApp.isPackaged = false
        try {
          const env = await daemonSpawnAndGetEnv({ PATH: '/usr/bin' })
          expect(env.ORCA_USER_DATA_PATH).toBe('/tmp/orca-user-data')
          expect(env.PATH).toContain(join('/tmp/orca-user-data', 'cli', 'bin'))
        } finally {
          mockedApp.isPackaged = prev
        }
      })
      it('preserves the inherited PATH when dev-mode daemon env omits PATH', async () => {
        const { app } = await import('electron')
        const mockedApp = app as unknown as { isPackaged: boolean }
        const prev = mockedApp.isPackaged
        mockedApp.isPackaged = false
        try {
          const env = await daemonSpawnAndGetEnv({}, undefined, undefined, {
            PATH: '/system/bin'
          })
          expect(env.ORCA_USER_DATA_PATH).toBe('/tmp/orca-user-data')
          expect(env.PATH).toContain(
            `${join('/tmp/orca-user-data', 'cli', 'bin')}${delimiter}/system/bin`
          )
        } finally {
          mockedApp.isPackaged = prev
        }
      })
      it('drops a legacy shim PATH entry inherited from the host process on the daemon path', async () => {
        // Why: the daemon path passes a sparse env, so the prepends re-read PATH from
        // process.env — the scrub must outlive that fallback (pre-upgrade host or parent pane).
        const { app } = await import('electron')
        const mockedApp = app as unknown as { isPackaged: boolean }
        const prev = mockedApp.isPackaged
        mockedApp.isPackaged = false
        try {
          const env = await daemonSpawnAndGetEnv({}, undefined, undefined, {
            PATH: `/tmp/orca-user-data/orca-terminal-attribution/posix${delimiter}/system/bin`
          })
          expect(env.PATH).not.toContain('orca-terminal-attribution')
          expect(env.PATH).toContain('/system/bin')
        } finally {
          mockedApp.isPackaged = prev
        }
      })
      it('defers indexed Git prompt guards from the daemon wire environment', async () => {
        const env = await daemonSpawnAndGetEnv(
          {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.proxy',
            GIT_CONFIG_VALUE_0: 'http://proxy.invalid'
          },
          undefined,
          undefined,
          undefined,
          { command: 'claude' }
        )

        expect(env.GIT_TERMINAL_PROMPT).toBe('0')
        expect(env.GCM_INTERACTIVE).toBe('never')
        expect(env.GIT_CONFIG_COUNT).toBe('1')
        expect(env.GIT_CONFIG_KEY_0).toBe('http.proxy')
        expect(env.GIT_CONFIG_KEY_1).toBeUndefined()
      })
    })
  })
})
