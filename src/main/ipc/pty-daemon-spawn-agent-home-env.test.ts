import { describe, expect, it, vi } from 'vitest'
import { piBuildPtyEnvMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  type DaemonSpawnCall,
  createDaemonActiveProviderFixtures
} from './pty-ipc-daemon-provider-fixtures'
import { delimiter, join } from 'node:path'
import type { TuiAgent } from '../../shared/tui-agent'
import { LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS } from '../pty/legacy-terminal-shim-dir'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
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
        daemonSpawnAndGetOptions,
        daemonSpawnAndGetEnv
      } = createDaemonActiveProviderFixtures({ handlers, mainWindow })

      // Why: under the daemon, LocalPtyProvider.buildSpawnEnv never runs, so host-local env injection must happen in the pty:spawn handler instead.
      it('overrides an unmarked custom home for an authoritative daemon resume', async () => {
        const daemonSpawn = setupDaemonAdapter()
        const selectedHome = vi.fn(() => '/managed/current/home')
        const systemHome = '/Users/example/.codex'
        handlers.clear()
        registerPtyHandlers(
          mainWindow as never,
          undefined,
          selectedHome,
          undefined,
          undefined,
          undefined,
          {
            prepareCodexSessionResume: async () => ({
              outcome: 'resume' as const,
              codexHomePath: systemHome
            })
          }
        )

        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          command: 'codex resume session-a',
          env: { CODEX_HOME: '/custom/codex', REMOVE_ME: 'stale' },
          envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME', 'REMOVE_ME'],
          launchAgent: 'codex',
          resumeProviderSession: {
            key: 'session_id',
            id: 'session-a',
            transcriptPath: `${systemHome}/sessions/2026/07/20/rollout-a.jsonl`
          }
        })

        const env = daemonSpawn.mock.calls.at(-1)![0].env
        expect(selectedHome).not.toHaveBeenCalled()
        expect(env.CODEX_HOME).toBe(systemHome)
        expect(env.ORCA_CODEX_HOME).toBe(systemHome)
        expect(env.REMOVE_ME).toBeUndefined()
      })
      it('keeps the authoritative home for runtime-created daemon resumes', async () => {
        type RuntimeSpawnController = {
          spawn(args: {
            cols: number
            rows: number
            command: string
            env: Record<string, string>
            envToDelete: string[]
            launchAgent: 'codex'
            resumeProviderSession: {
              key: 'session_id'
              id: string
              transcriptPath: string
            }
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
        const systemHome = '/Users/example/.codex'
        handlers.clear()
        registerPtyHandlers(
          mainWindow as never,
          runtime as never,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            prepareCodexSessionResume: async () => ({
              outcome: 'resume' as const,
              codexHomePath: systemHome
            })
          }
        )
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

        await controller.spawn({
          cols: 80,
          rows: 24,
          command: 'codex resume session-a',
          env: { CODEX_HOME: '/custom/codex', REMOVE_ME: 'stale' },
          envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME', 'REMOVE_ME'],
          launchAgent: 'codex',
          resumeProviderSession: {
            key: 'session_id',
            id: 'session-a',
            transcriptPath: `${systemHome}/sessions/2026/07/20/rollout-a.jsonl`
          }
        })

        const spawnOptions = daemonSpawn.mock.calls.at(-1)?.[0] as DaemonSpawnCall
        expect(spawnOptions.env.CODEX_HOME).toBe(systemHome)
        expect(spawnOptions.env.ORCA_CODEX_HOME).toBe(systemHome)
        expect(spawnOptions.env.REMOVE_ME).toBeUndefined()
        expect(spawnOptions.envToDelete ?? []).not.toContain('CODEX_HOME')
        expect(spawnOptions.envToDelete ?? []).not.toContain('ORCA_CODEX_HOME')
        expect(spawnOptions.envToDelete).toContain('REMOVE_ME')
      })
      it('prepares Codex project trust before a daemon-backed interactive launch', async () => {
        const workspacePath = '/repo/worktrees/new-feature'
        const resolveHome = vi.fn(
          (
            _target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null },
            _launchEnv?: NodeJS.ProcessEnv,
            _launchContext?: { workspacePath?: string; launchAgent?: TuiAgent }
          ) => null
        )

        await daemonSpawnAndGetOptions({}, resolveHome, undefined, undefined, {
          cwd: workspacePath,
          worktreeId: `repo-id::${workspacePath}`,
          command: 'codex',
          launchAgent: 'codex'
        })

        expect(resolveHome.mock.calls[0]?.[0]).toEqual({ runtime: 'host' })
        expect(resolveHome.mock.calls[0]?.[2]).toEqual({ workspacePath, launchAgent: 'codex' })
      })
      it('injects explicit proxy settings on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({}, undefined, () => ({
          httpProxyUrl: 'http://proxy.example:8080',
          httpProxyBypassRules: 'localhost;*.internal'
        }))

        expect(env.HTTP_PROXY).toBe('http://proxy.example:8080')
        expect(env.HTTPS_PROXY).toBe('http://proxy.example:8080')
        expect(env.NO_PROXY).toBe('localhost,*.internal')
      })
      it('skips host Codex home when a daemon-backed Windows spawn targets a WSL cwd', async () => {
        const originalPlatform = process.platform
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: 'win32'
        })
        try {
          const spawnOptions = await daemonSpawnAndGetOptions(
            {},
            () => 'C:\\Users\\test\\AppData\\Roaming\\Orca\\codex-runtime-home\\home',
            undefined,
            {
              CODEX_HOME: 'C:\\Users\\test\\AppData\\Roaming\\Orca\\codex-runtime-home\\home',
              ORCA_CODEX_HOME: 'C:\\Users\\test\\AppData\\Roaming\\Orca\\codex-runtime-home\\home'
            },
            {
              cwd: '\\\\wsl.localhost\\Ubuntu\\home\\test\\repo',
              worktreeId: 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\test\\repo'
            }
          )
          const { env } = spawnOptions
          expect(env.CODEX_HOME).toBeUndefined()
          expect(env.ORCA_CODEX_HOME).toBeUndefined()
          expect(spawnOptions.envToDelete).toEqual(
            expect.arrayContaining(['CODEX_HOME', 'ORCA_CODEX_HOME'])
          )
        } finally {
          Object.defineProperty(process, 'platform', {
            configurable: true,
            value: originalPlatform
          })
        }
      })
      it('skips host Codex home when a daemon-backed Windows spawn uses a WSL shell override', async () => {
        const originalPlatform = process.platform
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: 'win32'
        })
        try {
          const spawnOptions = await daemonSpawnAndGetOptions(
            {},
            () => 'C:\\Users\\test\\AppData\\Roaming\\Orca\\codex-runtime-home\\home',
            undefined,
            {
              CODEX_HOME: 'C:\\Users\\test\\.codex',
              ORCA_CODEX_HOME: 'C:\\Users\\test\\AppData\\Roaming\\Orca\\codex-runtime-home\\home'
            },
            { shellOverride: 'wsl.exe' }
          )
          expect(spawnOptions.env.CODEX_HOME).toBeUndefined()
          expect(spawnOptions.env.ORCA_CODEX_HOME).toBeUndefined()
          expect(spawnOptions.envToDelete).toEqual(
            expect.arrayContaining(['CODEX_HOME', 'ORCA_CODEX_HOME'])
          )
        } finally {
          Object.defineProperty(process, 'platform', {
            configurable: true,
            value: originalPlatform
          })
        }
      })
      it('drops OPENCODE_CONFIG_DIR for a WSL daemon spawn until the guest overlay is known', async () => {
        await withWin32Platform(async () => {
          const env = await daemonSpawnAndGetEnv({}, undefined, undefined, undefined, {
            shellOverride: 'wsl.exe'
          })
          // Why: relay not connected yet → never cross the Windows overlay path into WSL.
          expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
          expect(env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
          expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
        })
      })
      it('does not install or inject a Prime extension for an explicit WSL launch', async () => {
        await withWin32Platform(async () => {
          const env = await daemonSpawnAndGetEnv(
            {
              PRIME_AGENT_CODING_AGENT_DIR: 'C:\\Users\\test\\.prime\\agent',
              ORCA_PRIME_AGENT_STATUS_EXTENSION: 'C:\\stale\\orca-agent-status.ts'
            },
            undefined,
            undefined,
            undefined,
            { shellOverride: 'wsl.exe', command: 'prime-agent', launchAgent: 'prime-agent' }
          )

          expect(piBuildPtyEnvMock).not.toHaveBeenCalled()
          expect(env.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR).toBeUndefined()
          expect(env.ORCA_PRIME_AGENT_STATUS_EXTENSION).toBeUndefined()
          expect(env.ORCA_WSL_HOOK_INSTANCE).toBeUndefined()
          expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBe('C:\\Users\\test\\.prime\\agent')
        })
      })
      it('does not prepare a Prime extension for a typed launch in a bare WSL shell', async () => {
        await withWin32Platform(async () => {
          const env = await daemonSpawnAndGetEnv({}, undefined, undefined, undefined, {
            shellOverride: 'wsl.exe'
          })

          expect(piBuildPtyEnvMock.mock.calls.some(([, , kind]) => kind === 'prime-agent')).toBe(
            false
          )
          expect(env.ORCA_PRIME_AGENT_STATUS_EXTENSION).toBeUndefined()
          expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBeUndefined()
        })
      })
      it('points OPENCODE_CONFIG_DIR at the guest overlay when the WSL relay reports it', async () => {
        const guestDir = '/home/jin/.orca-relay/opencode-overlays/abc'
        const spy = vi.spyOn(wslHookRelayManager, 'getOpenCodeOverlayDir').mockReturnValue(guestDir)
        try {
          await withWin32Platform(async () => {
            const env = await daemonSpawnAndGetEnv(
              { ORCA_OPENCODE_SOURCE_CONFIG_DIR: '/home/jin/.config/opencode' },
              undefined,
              undefined,
              undefined,
              { shellOverride: 'wsl.exe' }
            )
            expect(env.OPENCODE_CONFIG_DIR).toBe(guestDir)
            expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe(guestDir)
            // The Windows-side source pointer must not cross into the guest.
            expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
          })
        } finally {
          spy.mockRestore()
        }
      })
      it('strips the daemon-inherited Orca-owned CODEX_HOME for real-home routing', async () => {
        const spawnOptions = await daemonSpawnAndGetOptions(
          {},
          () => null,
          () => ({ codexSystemDefaultRealHomeEnabled: true }) as never,
          { CODEX_HOME: '/managed/home', ORCA_CODEX_HOME: '/managed/home' }
        )
        expect(spawnOptions.env.CODEX_HOME).toBeUndefined()
        expect(spawnOptions.env.ORCA_CODEX_HOME).toBeUndefined()
        expect(spawnOptions.envToDelete).toEqual(expect.arrayContaining(['ORCA_CODEX_HOME']))
        // The daemon compares its own merged values before deleting CODEX_HOME.
        expect(spawnOptions.envToDelete).not.toContain('CODEX_HOME')
      })
      it('preserves a daemon-inherited user CODEX_HOME for real-home routing', async () => {
        const spawnOptions = await daemonSpawnAndGetOptions(
          {},
          () => null,
          () => ({ codexSystemDefaultRealHomeEnabled: true }) as never,
          { CODEX_HOME: '/home/me/.config/codex', ORCA_CODEX_HOME: undefined }
        )
        expect(spawnOptions.envToDelete).toEqual(expect.arrayContaining(['ORCA_CODEX_HOME']))
        expect(spawnOptions.envToDelete).not.toEqual(expect.arrayContaining(['CODEX_HOME']))
      })
      it('does not strip the daemon-inherited CODEX_HOME when the flag is OFF', async () => {
        const spawnOptions = await daemonSpawnAndGetOptions({}, () => null, undefined, {
          CODEX_HOME: '/managed/home',
          ORCA_CODEX_HOME: '/managed/home'
        })
        expect(spawnOptions.envToDelete ?? []).not.toEqual(expect.arrayContaining(['CODEX_HOME']))
      })
      it('strips inherited Claude child-session stamps from daemon spawns', async () => {
        // Why: a daemon forked from inside a Claude Code session inherits these
        // stamps and would mark every terminal as a nested Claude child, which
        // silently disables transcript persistence for real user sessions.
        const spawnOptions = await daemonSpawnAndGetOptions(undefined, undefined, undefined, {
          CLAUDE_CODE_CHILD_SESSION: '1',
          CLAUDE_CODE_SESSION_ID: '85935aed-98a7-4094-89a8-85c75e1a5a95',
          CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_01UCkWN5nDXNyD1V7cfamCxa'
        })
        expect(spawnOptions.envToDelete).toEqual(
          expect.arrayContaining([
            'CLAUDE_CODE_CHILD_SESSION',
            'CLAUDE_CODE_SESSION_ID',
            'CLAUDE_CODE_BRIDGE_SESSION_ID'
          ])
        )
      })
      it('preserves an explicitly requested Claude child-session stamp', async () => {
        // Why: only inherited values are poison; a caller deliberately spawning a
        // nested Claude child passes the stamp in args.env and must keep it.
        const spawnOptions = await daemonSpawnAndGetOptions(
          { CLAUDE_CODE_CHILD_SESSION: '1' },
          undefined,
          undefined,
          { CLAUDE_CODE_CHILD_SESSION: '1' }
        )
        expect(spawnOptions.envToDelete ?? []).not.toEqual(
          expect.arrayContaining(['CLAUDE_CODE_CHILD_SESSION'])
        )
        expect(spawnOptions.env.CLAUDE_CODE_CHILD_SESSION).toBe('1')
      })
      it('prepends the bare-orca CLI shim dir to PATH for packaged Linux spawns', async () => {
        const originalPlatform = process.platform
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: 'linux'
        })
        try {
          // Why: overriding process.platform doesn't change the loaded node:path dialect; keep this synthetic PATH consistent.
          const env = await daemonSpawnAndGetEnv({
            PATH: ['/usr/local/bin', '/usr/bin'].join(delimiter)
          })
          const entries = env.PATH.split(delimiter)
          const shimDir = join('/tmp/orca-user-data', 'linux-orca-cli-shim')
          // Why: bare `orca` must resolve to the Orca CLI before /usr/bin/orca (the GNOME screen reader) in Orca terminals (#7904).
          expect(entries.indexOf(shimDir)).toBeGreaterThanOrEqual(0)
          expect(entries.indexOf(shimDir)).toBeLessThan(entries.indexOf('/usr/bin'))
          expect(env.ORCA_CLI_COMMAND).toBeUndefined()
        } finally {
          Object.defineProperty(process, 'platform', {
            configurable: true,
            value: originalPlatform
          })
        }
      })
      it('prepends the bundled CLI dir to PATH for packaged macOS spawns', async () => {
        const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
        Object.defineProperty(process, 'resourcesPath', {
          configurable: true,
          value: '/tmp/orca-resources'
        })
        try {
          const env = await daemonSpawnAndGetEnv({ PATH: '/usr/bin' })
          expect(env.PATH.split(delimiter)[0]).toBe(join('/tmp/orca-resources', 'bin'))
        } finally {
          if (resourcesPathDescriptor) {
            Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor)
          } else {
            Reflect.deleteProperty(process, 'resourcesPath')
          }
        }
      })
      it('injects the agent-hook receiver env on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({})
        expect(env.ORCA_AGENT_HOOK_PORT).toBe('5678')
        expect(env.ORCA_AGENT_HOOK_TOKEN).toBe('agent-token')
      })
      it('deletes stale Claude scoped settings env from daemon-hosted PTYs', async () => {
        const spawnOptions = await daemonSpawnAndGetOptions({}, undefined, undefined, {
          ORCA_CLAUDE_AGENT_STATUS_SETTINGS:
            '/tmp/orca/agent-hooks/claude-agent-status-settings.json'
        })
        expect(spawnOptions.env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS).toBeUndefined()
        expect(spawnOptions.envToDelete).toEqual(
          expect.arrayContaining(['ORCA_CLAUDE_AGENT_STATUS_SETTINGS'])
        )
        expect(spawnOptions.env.ORCA_AGENT_HOOK_PORT).toBe('5678')
        expect(spawnOptions.env.ORCA_AGENT_HOOK_TOKEN).toBe('agent-token')
      })
      it('asks surviving pre-upgrade daemons to delete legacy attribution env', async () => {
        const spawnOptions = await daemonSpawnAndGetOptions({})

        expect(spawnOptions.envToDelete).toEqual(
          expect.arrayContaining([...LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS])
        )
        expect(spawnOptions.envToDelete).not.toContain('ORCA_REAL_GIT')
        expect(spawnOptions.envToDelete).not.toContain('ORCA_REAL_GH')
      })
      it('deletes stale Claude scoped settings env from runtime-created daemon PTYs', async () => {
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
        process.env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS =
          '/tmp/orca/agent-hooks/claude-agent-status-settings.json'
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

        await controller.spawn({ cols: 80, rows: 24, worktreeId: 'wt-runtime', env: {} })

        const spawnOptions = daemonSpawn.mock.calls.at(-1)?.[0] as DaemonSpawnCall
        expect(spawnOptions.env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS).toBeUndefined()
        expect(spawnOptions.envToDelete).toEqual(
          expect.arrayContaining(['ORCA_CLAUDE_AGENT_STATUS_SETTINGS'])
        )
        expect(spawnOptions.env.ORCA_AGENT_HOOK_PORT).toBe('5678')
        expect(spawnOptions.env.ORCA_AGENT_HOOK_TOKEN).toBe('agent-token')
      })
      it('asks surviving pre-upgrade daemons to delete legacy attribution env for runtime PTYs', async () => {
        type RuntimeSpawnController = {
          spawn(args: {
            cols: number
            rows: number
            worktreeId?: string
            env?: Record<string, string>
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

        await controller.spawn({ cols: 80, rows: 24, worktreeId: 'wt-runtime', env: {} })

        const spawnOptions = daemonSpawn.mock.calls.at(-1)?.[0] as DaemonSpawnCall
        expect(spawnOptions.envToDelete).toEqual(
          expect.arrayContaining([...LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS])
        )
        expect(spawnOptions.envToDelete).not.toContain('ORCA_REAL_GIT')
        expect(spawnOptions.envToDelete).not.toContain('ORCA_REAL_GH')
      })
      it('strips inherited Claude child-session stamps from runtime-created PTYs', async () => {
        // Why: the runtime controller is the `orca` CLI / automation spawn path and
        // assembles envToDelete separately from the renderer's pty:spawn handler;
        // without its own case the two paths can silently drift apart.
        type RuntimeSpawnController = {
          spawn(args: {
            cols: number
            rows: number
            worktreeId?: string
            env?: Record<string, string>
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

        await controller.spawn({ cols: 80, rows: 24, worktreeId: 'wt-runtime', env: {} })

        const spawnOptions = daemonSpawn.mock.calls.at(-1)?.[0] as DaemonSpawnCall
        expect(spawnOptions.envToDelete).toEqual(
          expect.arrayContaining([
            'CLAUDE_CODE_CHILD_SESSION',
            'CLAUDE_CODE_SESSION_ID',
            'CLAUDE_CODE_BRIDGE_SESSION_ID'
          ])
        )
      })
    })
  })
})
