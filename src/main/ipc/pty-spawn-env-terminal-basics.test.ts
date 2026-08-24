import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { BUNDLED_CLI_PATH, TEST_CODEX_HOME, makeDisposable } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { delimiter } from 'node:path'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import { __resetPersistedWindowsPathCacheForTests } from '../pty/windows-environment-path'
import { __setWindowsPathRegistryLoaderForTests } from '../pty/windows-path-registry-reader'
import { hasLiveClaudePtys, markClaudePtySpawned } from '../claude-accounts/live-pty-gate'
import { registerPtyHandlers, buildPtyHostEnv, clearProviderPtyState } from './pty'

const prepareManagedCodexHomeMock = vi.hoisted(() => vi.fn(() => null))
vi.mock('../codex/managed-home-shell-preflight', () => ({
  prepareManagedCodexHomeBeforeShellLaunch: prepareManagedCodexHomeMock,
  resolveManagedCodexShellPreflightHome: () => null
}))
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
  const { handlers, mainWindow, spawnAndGetEnv, withBundledCli } = setupPtyIpcSuite()

  describe('spawn environment', () => {
    it('refreshes the outer Windows PATH for a WSL spawn without forwarding it', async () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      __setWindowsPathRegistryLoaderForTests(() => ({
        HK: { LM: 1, CU: 2 },
        getRegistryKey: (root) => ({
          Path: {
            type: 1,
            value:
              root === 1
                ? 'C:\\Windows\\System32'
                : 'C:\\Python314;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps'
          }
        })
      }))
      __resetPersistedWindowsPathCacheForTests()

      try {
        const provider = new LocalPtyProvider({
          buildSpawnEnv: (id, baseEnv, context) =>
            buildPtyHostEnv(id, baseEnv, {
              isPackaged: true,
              userDataPath: '/tmp/orca-user-data',
              selectedCodexHomePath: null,
              agentStatusHooksEnabled: false,
              isWsl: context?.isWsl,
              wslDistro: context?.wslDistro
            })
        })
        await provider.spawn({
          cols: 80,
          rows: 24,
          cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
          shellOverride: 'wsl.exe',
          terminalWindowsWslDistro: 'Ubuntu',
          env: {
            PATH: 'C:\\Orca\\bin;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps',
            WSLENV: 'ORCA_TERMINAL_HANDLE/u'
          }
        })
        const [file, , options] = spawnMock.mock.calls.at(-1)!

        expect(file).toBe('wsl.exe')
        expect(options.env.PATH).toBe(
          'C:\\Orca\\bin;C:\\Windows\\System32;C:\\Python314;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps'
        )
        const forwardedKeys = options.env.WSLENV.split(':').map((entry) =>
          entry.split('/')[0]!.toLowerCase()
        )
        expect(options.env.WSLENV).toContain('ORCA_TERMINAL_HANDLE/u')
        expect(forwardedKeys).not.toContain('path')
      } finally {
        __resetPersistedWindowsPathCacheForTests()
        __setWindowsPathRegistryLoaderForTests()
        Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
      }
    })
    it('publishes a lifecycle signal after a successful renderer spawn', async () => {
      await spawnAndGetEnv()

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:spawned', {
        id: expect.any(String)
      })
    })
    it('marks local Claude launches live until the PTY is killed', async () => {
      let exitCb: ((info: { exitCode: number }) => void) | undefined
      spawnMock.mockReturnValue({
        onData: vi.fn(() => makeDisposable()),
        onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
          exitCb = cb
          return makeDisposable()
        }),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => exitCb?.({ exitCode: -1 })),
        process: 'zsh',
        pid: 12345
      })
      const prepareClaudeAuth = vi.fn(async () => ({
        configDir: '/tmp/claude',
        envPatch: {},
        stripAuthEnv: false,
        provenance: 'managed:account-1'
      }))
      registerPtyHandlers(mainWindow as never, undefined, undefined, undefined, prepareClaudeAuth)

      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        command: 'claude'
      })) as { id: string }

      expect(prepareClaudeAuth).toHaveBeenCalledTimes(1)
      expect(hasLiveClaudePtys()).toBe(true)

      await handlers.get('pty:kill')!(null, { id: spawnResult.id })

      expect(hasLiveClaudePtys()).toBe(false)
    })
    it('clears Claude live-PTY tracking from shared provider teardown', () => {
      markClaudePtySpawned('ssh-claude-pty')
      expect(hasLiveClaudePtys()).toBe(true)

      clearProviderPtyState('ssh-claude-pty')

      expect(hasLiveClaudePtys()).toBe(false)
    })
    it('defaults LANG to en_US.UTF-8 when not inherited from process.env', async () => {
      const env = await spawnAndGetEnv(undefined, { LANG: undefined })
      expect(env.LANG).toBe('en_US.UTF-8')
    })
    it('inherits LANG from process.env when already set', async () => {
      const env = await spawnAndGetEnv(undefined, { LANG: 'ja_JP.UTF-8' })
      expect(env.LANG).toBe('ja_JP.UTF-8')
    })
    it('lets caller-provided env override LANG', async () => {
      const env = await spawnAndGetEnv({ LANG: 'fr_FR.UTF-8' })
      expect(env.LANG).toBe('fr_FR.UTF-8')
    })
    it('strips inherited Claude child-session stamps from a local spawn env', async () => {
      // Why: the local provider spreads main's process.env, so a GUI launched from
      // inside a Claude session would stamp every pane as a nested child and Claude
      // would silently disable transcript persistence. Not gated on isDaemonHostSpawn.
      const env = await spawnAndGetEnv(undefined, {
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: '85935aed-98a7-4094-89a8-85c75e1a5a95',
        CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_01UCkWN5nDXNyD1V7cfamCxa'
      })
      expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
      expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
      expect(env.CLAUDE_CODE_BRIDGE_SESSION_ID).toBeUndefined()
    })
    it('keeps an explicitly requested Claude child-session stamp on a local spawn', async () => {
      const env = await spawnAndGetEnv(
        { CLAUDE_CODE_CHILD_SESSION: '1' },
        { CLAUDE_CODE_CHILD_SESSION: '1' }
      )
      expect(env.CLAUDE_CODE_CHILD_SESSION).toBe('1')
    })
    it('always sets TERM and COLORTERM regardless of env', async () => {
      const env = await spawnAndGetEnv()
      expect(env.TERM).toBe('xterm-256color')
      expect(env.COLORTERM).toBe('truecolor')
      expect(env.TERM_PROGRAM).toBe('Orca')
    })
    it('keeps indexed Git prompt guards in a local agent terminal env', async () => {
      const env = await spawnAndGetEnv(undefined, undefined, undefined, undefined, 'claude')
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(env.GCM_INTERACTIVE).toBe('never')
      expect(Object.values(env)).toContain('credential.interactive')
      expect(Object.values(env)).toContain('credential.guiPrompt')
    })
    it('guards a trusted local agent when its command uses a custom wrapper', async () => {
      const env = await spawnAndGetEnv(
        undefined,
        undefined,
        undefined,
        undefined,
        'cd /repo && custom-agent-wrapper',
        'claude'
      )
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(env.GCM_INTERACTIVE).toBe('never')
    })
    it('advertises OSC 8 hyperlink support via FORCE_HYPERLINK', async () => {
      // Why: supports-hyperlinks allowlists TERM_PROGRAM and reports false for Orca, so FORCE_HYPERLINK=1 forces detection on (xterm.js handles OSC 8 natively).
      const env = await spawnAndGetEnv()
      expect(env.FORCE_HYPERLINK).toBe('1')
    })
    it('surfaces ORCA_APP_VERSION as TERM_PROGRAM_VERSION for TUI feature gating', async () => {
      const env = await spawnAndGetEnv(undefined, { ORCA_APP_VERSION: '1.2.3-test' })
      expect(env.TERM_PROGRAM_VERSION).toBe('1.2.3-test')
    })
    it('falls back to a placeholder version when ORCA_APP_VERSION is unset', async () => {
      const env = await spawnAndGetEnv(undefined, { ORCA_APP_VERSION: undefined })
      expect(env.TERM_PROGRAM_VERSION).toBe('0.0.0-dev')
    })
    it('injects the selected Codex home into Orca terminal PTYs', async () => {
      const env = await withBundledCli(() =>
        spawnAndGetEnv(undefined, undefined, () => TEST_CODEX_HOME)
      )
      expect(env.CODEX_HOME).toBe(TEST_CODEX_HOME)
      expect(env.ORCA_CODEX_HOME).toBe(TEST_CODEX_HOME)
      // Why (STA-4270): a bare name would be resolved by the post-profile PATH the codex()
      // wrapper inherits, so the preflight must carry the CLI's verified absolute path.
      expect(env.ORCA_CODEX_LAUNCH_PREFLIGHT).toBe(BUNDLED_CLI_PATH)
    })
    // Why: cmd.exe has no deferred `codex` wrapper, so its preflight ran inline at
    // shell start as a CLI round-trip into this app — slow enough to push agent
    // launches past their startup budget. Same prep, done in-process instead.
    it('prepares the managed Codex home in-process instead of from the shell', async () => {
      prepareManagedCodexHomeMock.mockClear()
      const env = await withBundledCli(() =>
        spawnAndGetEnv(undefined, undefined, () => TEST_CODEX_HOME)
      )

      expect(env.ORCA_CODEX_LAUNCH_PREFLIGHT).toBe(BUNDLED_CLI_PATH)
      expect(prepareManagedCodexHomeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          hooksEnabled: true,
          env: expect.objectContaining({
            CODEX_HOME: TEST_CODEX_HOME,
            ORCA_CODEX_HOME: TEST_CODEX_HOME
          })
        })
      )
    })
    it('does not prepare a managed Codex home when no preflight is installed', async () => {
      prepareManagedCodexHomeMock.mockClear()
      await withBundledCli(() => spawnAndGetEnv(undefined, undefined, () => TEST_CODEX_HOME), {
        launcherExecutable: false
      })

      expect(prepareManagedCodexHomeMock).not.toHaveBeenCalled()
    })
    it('skips the Codex launch preflight when the bundled CLI is not executable', async () => {
      const env = await withBundledCli(
        () => spawnAndGetEnv(undefined, undefined, () => TEST_CODEX_HOME),
        { launcherExecutable: false }
      )

      expect(env.CODEX_HOME).toBe(TEST_CODEX_HOME)
      expect(env.ORCA_CODEX_LAUNCH_PREFLIGHT).toBeUndefined()
    })
    // Why (STA-4270): profile scripts run before the codex() wrapper and routinely prepend
    // directories to PATH, so a scratch `orca` there must never become the preflight.
    it('pins the Codex launch preflight to the bundled CLI even when PATH leads elsewhere', async () => {
      const env = await withBundledCli(() =>
        spawnAndGetEnv(
          { PATH: `/tmp/hijack-scratch${delimiter}/usr/bin` },
          undefined,
          () => TEST_CODEX_HOME
        )
      )

      expect(env.ORCA_CODEX_LAUNCH_PREFLIGHT).toBe(BUNDLED_CLI_PATH)
      expect(env.ORCA_CODEX_LAUNCH_PREFLIGHT).not.toBe('orca')
      expect(env.ORCA_CODEX_LAUNCH_PREFLIGHT.startsWith('/tmp/hijack-scratch')).toBe(false)
    })
    it('does not install the Codex launch preflight when Codex hooks are disabled', async () => {
      const env = await spawnAndGetEnv(
        undefined,
        undefined,
        () => TEST_CODEX_HOME,
        () => ({ agentStatusHooksEnabled: true, disabledTuiAgents: ['codex'] })
      )

      expect(env.CODEX_HOME).toBe(TEST_CODEX_HOME)
      expect(env.ORCA_CODEX_LAUNCH_PREFLIGHT).toBeUndefined()
    })
    it('resumes an automatic Codex session from its prepared originating home', async () => {
      const selectedHome = vi.fn(() => '/managed/current/home')
      const prepareResume = vi.fn(async () => ({
        outcome: 'resume' as const,
        codexHomePath: '/managed/origin/home'
      }))
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        selectedHome,
        undefined,
        undefined,
        undefined,
        { prepareCodexSessionResume: prepareResume }
      )

      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        command: 'codex resume session-a',
        launchAgent: 'codex',
        resumeProviderSession: {
          key: 'session_id',
          id: 'session-a',
          transcriptPath: '/managed/origin/home/sessions/2026/07/20/rollout-a.jsonl'
        }
      })

      const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
      expect(prepareResume).toHaveBeenCalledWith(
        expect.objectContaining({
          providerSession: expect.objectContaining({ id: 'session-a' }),
          target: { runtime: 'host' }
        })
      )
      expect(selectedHome).not.toHaveBeenCalled()
      expect(env.CODEX_HOME).toBe('/managed/origin/home')
      expect(env.ORCA_CODEX_HOME).toBe('/managed/origin/home')
    })
    it('blocks a shared-runtime resume when auth reconciliation fails', async () => {
      const selectedHome = vi.fn(() => {
        throw new Error('Cannot safely launch Codex while stale runtime auth remains.')
      })
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
            codexHomePath: '/managed/shared-mirror/home',
            reconcileSharedRuntimeAuth: true
          })
        }
      )

      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          command: 'codex resume session-a',
          launchAgent: 'codex',
          resumeProviderSession: {
            key: 'session_id',
            id: 'session-a',
            transcriptPath: '/managed/shared-mirror/home/sessions/2026/07/20/rollout-a.jsonl'
          }
        })
      ).rejects.toThrow('Cannot safely launch Codex while stale runtime auth remains.')

      expect(selectedHome).toHaveBeenCalledTimes(1)
      expect(spawnMock).not.toHaveBeenCalled()
    })
    it('overrides an unmarked custom home when the resumed session originated in real home', async () => {
      const selectedHome = vi.fn(() => '/managed/current/home')
      const systemHome = '/Users/example/.codex'
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
          transcriptPath: '/Users/example/.codex/sessions/2026/07/20/rollout-a.jsonl'
        }
      })

      const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
      expect(selectedHome).not.toHaveBeenCalled()
      expect(env.CODEX_HOME).toBe(systemHome)
      expect(env.ORCA_CODEX_HOME).toBe(systemHome)
      expect(env.REMOVE_ME).toBeUndefined()
    })
    it('does not fall back to the selected account when automatic resume provenance is rejected', async () => {
      const selectedHome = vi.fn(() => '/managed/current/home')
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        selectedHome,
        undefined,
        undefined,
        undefined,
        {
          prepareCodexSessionResume: async () => {
            throw new Error('origin unavailable')
          }
        }
      )

      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          command: 'codex resume session-a',
          launchAgent: 'codex',
          resumeProviderSession: {
            key: 'session_id',
            id: 'session-a',
            transcriptPath: '/managed/origin/home/sessions/2026/07/20/rollout-a.jsonl'
          }
        })
      ).rejects.toThrow('origin unavailable')

      expect(selectedHome).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })
})
