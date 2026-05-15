/* eslint-disable max-lines -- Why: PTY spawn env behavior is easiest to verify in
one focused file because the registration helper is stateful and each spawn-path
assertion reuses the same mocked IPC and node-pty harness. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  onMock,
  removeHandlerMock,
  removeAllListenersMock,
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  readFileSyncMock,
  writeFileSyncMock,
  chmodSyncMock,
  getPathMock,
  spawnMock,
  openCodeBuildPtyEnvMock,
  openCodeClearPtyMock,
  buildAgentHookEnvMock,
  clearAgentHookPaneStateMock,
  registerPaneKeyAliasMock,
  piBuildPtyEnvMock,
  piClearPtyMock,
  isPwshAvailableMock,
  trackMock,
  classifyErrorMock,
  registerPtyMock,
  unregisterPtyMock,
  setMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPtysForPaneKeyMock,
  clearPaneKeyAliasesForPtyMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn(),
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  chmodSyncMock: vi.fn(),
  getPathMock: vi.fn(),
  spawnMock: vi.fn(),
  openCodeBuildPtyEnvMock: vi.fn(),
  isPwshAvailableMock: vi.fn(),
  openCodeClearPtyMock: vi.fn(),
  buildAgentHookEnvMock: vi.fn(),
  clearAgentHookPaneStateMock: vi.fn(),
  registerPaneKeyAliasMock: vi.fn(),
  piBuildPtyEnvMock: vi.fn(),
  piClearPtyMock: vi.fn(),
  trackMock: vi.fn(),
  classifyErrorMock: vi.fn(),
  registerPtyMock: vi.fn(),
  unregisterPtyMock: vi.fn(),
  setMigrationUnsupportedPtyMock: vi.fn(),
  clearMigrationUnsupportedPtyMock: vi.fn(),
  clearMigrationUnsupportedPtysForPaneKeyMock: vi.fn(),
  clearPaneKeyAliasesForPtyMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: getPathMock
  },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: chmodSyncMock,
  constants: {
    X_OK: 1
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('../opencode/hook-service', () => ({
  openCodeHookService: {
    buildPtyEnv: openCodeBuildPtyEnvMock,
    clearPty: openCodeClearPtyMock
  }
}))

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    buildPtyEnv: buildAgentHookEnvMock,
    clearPaneState: clearAgentHookPaneStateMock,
    registerPaneKeyAlias: registerPaneKeyAliasMock,
    clearPaneKeyAliasesForPty: clearPaneKeyAliasesForPtyMock
  }
}))

vi.mock('../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: {
    buildPtyEnv: piBuildPtyEnvMock,
    clearPty: piClearPtyMock
  }
}))

vi.mock('../pwsh', () => ({
  isPwshAvailable: isPwshAvailableMock
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/classify-error', () => ({
  classifyError: classifyErrorMock
}))

vi.mock('../memory/pty-registry', () => ({
  registerPty: registerPtyMock,
  unregisterPty: unregisterPtyMock
}))

vi.mock('../agent-hooks/migration-unsupported-pty-state', () => ({
  setMigrationUnsupportedPty: setMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPty: clearMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPtysForPaneKey: clearMigrationUnsupportedPtysForPaneKeyMock
}))
import { LocalPtyProvider } from '../providers/local-pty-provider'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  registerPtyHandlers,
  registerSshPtyProvider,
  clearProviderPtyState,
  deletePtyOwnership,
  getPtyIdForPaneKey,
  setPtyOwnership,
  setLocalPtyProvider,
  unregisterSshPtyProvider
} from './pty'
import { hasLiveClaudePtys } from '../claude-accounts/live-pty-gate'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from '../powershell-osc133-bootstrap'

const POWERSHELL_OSC133_ARGS = [
  '-NoLogo',
  '-NoExit',
  '-EncodedCommand',
  encodePowerShellCommand(getPowerShellOsc133Bootstrap())
]

function makeDisposable() {
  return { dispose: vi.fn() }
}

describe('registerPtyHandlers', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      on: vi.fn(),
      send: vi.fn(),
      removeListener: vi.fn()
    }
  }

  const savedOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR
  const savedOrcaOpenCodeConfigDir = process.env.ORCA_OPENCODE_CONFIG_DIR
  const savedOrcaOpenCodeSourceConfigDir = process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
  const savedPiAgentDir = process.env.PI_CODING_AGENT_DIR
  const savedOrcaPiAgentDir = process.env.ORCA_PI_CODING_AGENT_DIR
  const savedOrcaPiSourceAgentDir = process.env.ORCA_PI_SOURCE_AGENT_DIR

  beforeEach(() => {
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
    delete process.env.ORCA_OPENCODE_CONFIG_DIR
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.ORCA_PI_SOURCE_AGENT_DIR
    delete process.env.ORCA_PI_CODING_AGENT_DIR
    handlers.clear()
    handleMock.mockReset()
    onMock.mockReset()
    removeHandlerMock.mockReset()
    removeAllListenersMock.mockReset()
    existsSyncMock.mockReset()
    statSyncMock.mockReset()
    accessSyncMock.mockReset()
    mkdirSyncMock.mockReset()
    readFileSyncMock.mockReset()
    writeFileSyncMock.mockReset()
    chmodSyncMock.mockReset()
    getPathMock.mockReset()
    spawnMock.mockReset()
    openCodeBuildPtyEnvMock.mockReset()
    openCodeClearPtyMock.mockReset()
    buildAgentHookEnvMock.mockReset()
    clearAgentHookPaneStateMock.mockReset()
    registerPaneKeyAliasMock.mockReset()
    piBuildPtyEnvMock.mockReset()
    piClearPtyMock.mockReset()
    isPwshAvailableMock.mockReset()
    trackMock.mockReset()
    classifyErrorMock.mockReset()
    registerPtyMock.mockReset()
    unregisterPtyMock.mockReset()
    setMigrationUnsupportedPtyMock.mockReset()
    clearMigrationUnsupportedPtyMock.mockReset()
    clearMigrationUnsupportedPtysForPaneKeyMock.mockReset()
    clearPaneKeyAliasesForPtyMock.mockReset()
    mainWindow.webContents.on.mockReset()
    mainWindow.webContents.send.mockReset()

    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    getPathMock.mockReturnValue('/tmp/orca-user-data')
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ isDirectory: () => true, mode: 0o755 })
    readFileSyncMock.mockReturnValue('')
    openCodeBuildPtyEnvMock.mockImplementation((_ptyId: string, existingConfigDir?: string) => ({
      ORCA_OPENCODE_HOOK_PORT: '4567',
      ORCA_OPENCODE_HOOK_TOKEN: 'opencode-token',
      ORCA_OPENCODE_PTY_ID: 'test-pty',
      OPENCODE_CONFIG_DIR: existingConfigDir
        ? '/tmp/orca-opencode-overlay'
        : '/tmp/orca-opencode-config'
    }))
    buildAgentHookEnvMock.mockReturnValue({
      ORCA_AGENT_HOOK_PORT: '5678',
      ORCA_AGENT_HOOK_TOKEN: 'agent-token'
    })
    piBuildPtyEnvMock.mockImplementation((_ptyId: string, existingAgentDir?: string) => ({
      PI_CODING_AGENT_DIR: existingAgentDir
        ? '/tmp/orca-pi-agent-overlay'
        : '/tmp/orca-pi-agent-overlay'
    }))
    isPwshAvailableMock.mockReturnValue(false)
    spawnMock.mockReturnValue({
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      process: 'zsh',
      pid: 12345
    })
  })

  afterEach(() => {
    unregisterSshPtyProvider('ssh-1')
    setLocalPtyProvider(new LocalPtyProvider())
    if (savedOpenCodeConfigDir !== undefined) {
      process.env.OPENCODE_CONFIG_DIR = savedOpenCodeConfigDir
    } else {
      delete process.env.OPENCODE_CONFIG_DIR
    }
    if (savedOrcaOpenCodeConfigDir !== undefined) {
      process.env.ORCA_OPENCODE_CONFIG_DIR = savedOrcaOpenCodeConfigDir
    } else {
      delete process.env.ORCA_OPENCODE_CONFIG_DIR
    }
    if (savedOrcaOpenCodeSourceConfigDir !== undefined) {
      process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR = savedOrcaOpenCodeSourceConfigDir
    } else {
      delete process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
    }
    if (savedPiAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = savedPiAgentDir
    } else {
      delete process.env.PI_CODING_AGENT_DIR
    }
    if (savedOrcaPiAgentDir !== undefined) {
      process.env.ORCA_PI_CODING_AGENT_DIR = savedOrcaPiAgentDir
    } else {
      delete process.env.ORCA_PI_CODING_AGENT_DIR
    }
    if (savedOrcaPiSourceAgentDir === undefined) {
      delete process.env.ORCA_PI_SOURCE_AGENT_DIR
    } else {
      process.env.ORCA_PI_SOURCE_AGENT_DIR = savedOrcaPiSourceAgentDir
    }
  })

  function createMockProc() {
    let dataHandler: ((data: string) => void) | null = null
    let exitHandler: ((event: { exitCode: number }) => void) | null = null

    return {
      proc: {
        onData: vi.fn((handler: (data: string) => void) => {
          dataHandler = handler
          return makeDisposable()
        }),
        onExit: vi.fn((handler: (event: { exitCode: number }) => void) => {
          exitHandler = handler
          return makeDisposable()
        }),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn()
      },
      emitData(data: string) {
        dataHandler?.(data)
      },
      emitExit(exitCode = 0) {
        exitHandler?.({ exitCode })
      }
    }
  }

  /** Helper: trigger pty:spawn and return the env passed to node-pty. */
  async function spawnAndGetEnv(
    argsEnv?: Record<string, string>,
    processEnvOverrides?: Record<string, string | undefined>,
    getSelectedCodexHomePath?: () => string | null,
    getSettings?: () => { enableGitHubAttribution: boolean }
  ): Promise<Record<string, string>> {
    const savedEnv: Record<string, string | undefined> = {}
    if (processEnvOverrides) {
      for (const [k, v] of Object.entries(processEnvOverrides)) {
        savedEnv[k] = process.env[k]
        if (v === undefined) {
          delete process.env[k]
        } else {
          process.env[k] = v
        }
      }
    }

    try {
      // Clear previously registered handlers so re-registration doesn't
      // accumulate stale state across calls within one test.
      handlers.clear()
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        getSelectedCodexHomePath,
        getSettings as never
      )
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        ...(argsEnv ? { env: argsEnv } : {})
      })
      const spawnCall = spawnMock.mock.calls.at(-1)!
      return spawnCall[2].env as Record<string, string>
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
          delete process.env[k]
        } else {
          process.env[k] = v
        }
      }
    }
  }

  function spawnAndGetCall(args?: {
    cwd?: string
    env?: Record<string, string>
    command?: string
  }): [string, string[], { cwd: string; env: Record<string, string> }] {
    handlers.clear()
    registerPtyHandlers(mainWindow as never)
    handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      ...args
    })
    return spawnMock.mock.calls.at(-1) as [
      string,
      string[],
      { cwd: string; env: Record<string, string> }
    ]
  }

  describe('spawn environment', () => {
    it('marks local Claude launches live until the PTY is killed', async () => {
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

    it('always sets TERM and COLORTERM regardless of env', async () => {
      const env = await spawnAndGetEnv()
      expect(env.TERM).toBe('xterm-256color')
      expect(env.COLORTERM).toBe('truecolor')
      expect(env.TERM_PROGRAM).toBe('Orca')
    })

    it('advertises OSC 8 hyperlink support via FORCE_HYPERLINK', async () => {
      // Why: the supports-hyperlinks npm package hard-codes a TERM_PROGRAM
      // allowlist (iTerm.app / WezTerm / vscode) and reports false for
      // TERM_PROGRAM=Orca, so tools like Claude Code emit plain text instead
      // of ESC]8;; wrappers. Setting FORCE_HYPERLINK=1 forces the detector to
      // return true; xterm.js + our linkHandler handle the sequences natively.
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
      const env = await spawnAndGetEnv(undefined, undefined, () => '/tmp/orca-codex-home')
      expect(env.CODEX_HOME).toBe('/tmp/orca-codex-home')
    })

    it('injects the OpenCode hook env into Orca terminal PTYs', async () => {
      // Why: clear any ambient OPENCODE_CONFIG_DIR so the mock's value is used
      const env = await spawnAndGetEnv(undefined, { OPENCODE_CONFIG_DIR: undefined })
      expect(openCodeBuildPtyEnvMock).toHaveBeenCalledTimes(1)
      expect(openCodeBuildPtyEnvMock.mock.calls[0]?.[0]).toEqual(expect.any(String))
      expect(env.ORCA_OPENCODE_HOOK_PORT).toBe('4567')
      expect(env.ORCA_OPENCODE_HOOK_TOKEN).toBe('opencode-token')
      expect(env.ORCA_OPENCODE_PTY_ID).toBe('test-pty')
      expect(env.OPENCODE_CONFIG_DIR).toEqual(expect.any(String))
      expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe(env.OPENCODE_CONFIG_DIR)
    })

    it('mirrors the original OpenCode source dir when launched from an Orca overlay shell', async () => {
      const env = await spawnAndGetEnv({
        OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay',
        ORCA_OPENCODE_SOURCE_CONFIG_DIR: '/tmp/user-opencode-config'
      })
      expect(openCodeBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/user-opencode-config'
      )
      expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
      expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
      expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe('/tmp/user-opencode-config')
    })

    it('reproduces issue #1534: GUI-launched Orca mirrors zshrc-only OpenCode config', async () => {
      // Why: the reporter's app process did not inherit OPENCODE_CONFIG_DIR;
      // their interactive zsh startup later exported a company config repo.
      readFileSyncMock.mockImplementation((path: string) => {
        if (path.endsWith('.zshrc')) {
          return [
            '# Company-wide OpenCode config loaded by interactive shells',
            'export OPENCODE_CONFIG_DIR="$HOME/company/opencode-config"',
            ''
          ].join('\n')
        }
        return ''
      })

      const env = await spawnAndGetEnv(undefined, {
        HOME: '/home/pim',
        SHELL: '/bin/zsh',
        OPENCODE_CONFIG_DIR: undefined,
        ORCA_OPENCODE_SOURCE_CONFIG_DIR: undefined
      })

      expect(openCodeBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/home/pim/company/opencode-config'
      )
      expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
      expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-overlay')
      expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe('/home/pim/company/opencode-config')
      expect(env.OPENCODE_CONFIG_DIR).not.toBe(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR)
    })

    it('injects the Pi agent overlay env into Orca terminal PTYs', async () => {
      const env = await spawnAndGetEnv(undefined, { PI_CODING_AGENT_DIR: '/tmp/user-pi-agent' })
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), '/tmp/user-pi-agent')
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/orca-pi-agent-overlay')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBe('/tmp/orca-pi-agent-overlay')
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/tmp/user-pi-agent')
    })

    it('mirrors the original Pi source dir when launched from an Orca overlay shell', async () => {
      const env = await spawnAndGetEnv({
        PI_CODING_AGENT_DIR: '/tmp/parent-orca-pi-overlay',
        ORCA_PI_SOURCE_AGENT_DIR: '/tmp/user-pi-agent'
      })
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), '/tmp/user-pi-agent')
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/orca-pi-agent-overlay')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBe('/tmp/orca-pi-agent-overlay')
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/tmp/user-pi-agent')
    })

    it('mirrors Pi config exported only by shell startup files', async () => {
      readFileSyncMock.mockImplementation((path: string) =>
        path.endsWith('.zshrc') ? 'export PI_CODING_AGENT_DIR="$HOME/.config/pi-agent"\n' : ''
      )

      const env = await spawnAndGetEnv(undefined, {
        HOME: '/home/tester',
        SHELL: '/bin/zsh',
        PI_CODING_AGENT_DIR: undefined
      })

      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/home/tester/.config/pi-agent'
      )
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/orca-pi-agent-overlay')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBe('/tmp/orca-pi-agent-overlay')
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/home/tester/.config/pi-agent')
    })

    it('injects the Claude/Codex hook receiver env into Orca terminal PTYs', async () => {
      const env = await spawnAndGetEnv()
      // Why: after the daemon-parity refactor, buildAgentHookEnv runs exactly
      // once for a local spawn — inside the shared buildPtyHostEnv helper,
      // which LocalPtyProvider.buildSpawnEnv and the daemon-active fallback
      // both route through. The handler's separate ad-hoc injection (which
      // used to cause a double-call for local spawns) is gone.
      expect(buildAgentHookEnvMock).toHaveBeenCalledTimes(1)
      expect(env.ORCA_AGENT_HOOK_PORT).toBe('5678')
      expect(env.ORCA_AGENT_HOOK_TOKEN).toBe('agent-token')
    })

    it('prepends local git/gh attribution shims when attribution is enabled', async () => {
      const env = await spawnAndGetEnv(undefined, undefined, undefined, () => ({
        enableGitHubAttribution: true
      }))

      expect(env.ORCA_ENABLE_GIT_ATTRIBUTION).toBe('1')
      expect(env.ORCA_GIT_COMMIT_TRAILER).toBe('Co-authored-by: Orca <help@stably.ai>')
      expect(env.ORCA_GH_PR_FOOTER).toBe('Made with [Orca](https://github.com/stablyai/orca) 🐋')
      expect(env.ORCA_GH_ISSUE_FOOTER).toBe('Made with [Orca](https://github.com/stablyai/orca) 🐋')
      expect(env.PATH).toContain('/tmp/orca-user-data/orca-terminal-attribution/posix')
    })

    it('skips git/gh attribution shims when attribution is disabled', async () => {
      const env = await spawnAndGetEnv(undefined, undefined, undefined, () => ({
        enableGitHubAttribution: false
      }))

      expect(env.ORCA_ENABLE_GIT_ATTRIBUTION).toBeUndefined()
      expect(env.ORCA_GIT_COMMIT_TRAILER).toBeUndefined()
      expect(env.ORCA_GH_PR_FOOTER).toBeUndefined()
      expect(env.ORCA_GH_ISSUE_FOOTER).toBeUndefined()
      expect(env.PATH ?? '').not.toContain('/tmp/orca-user-data/orca-terminal-attribution/posix')
    })

    it('prepends git/gh attribution shims for daemon-backed local PTYs', async () => {
      const daemonSpawn = vi.fn(async (options) => ({ id: 'daemon-pty', pid: 123, ...options }))
      setLocalPtyProvider({
        spawn: daemonSpawn,
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
      registerPtyHandlers(mainWindow as never, undefined, undefined, (() => ({
        enableGitHubAttribution: true
      })) as never)

      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        env: {}
      })

      const env = daemonSpawn.mock.calls.at(-1)![0].env
      expect(env.ORCA_ENABLE_GIT_ATTRIBUTION).toBe('1')
      expect(env.PATH).toContain('/tmp/orca-user-data/orca-terminal-attribution/posix')
    })

    it('leaves ambient CODEX_HOME untouched when system default is selected', async () => {
      const env = await spawnAndGetEnv(
        undefined,
        { CODEX_HOME: '/tmp/system-codex-home' },
        () => null
      )
      expect(env.CODEX_HOME).toBe('/tmp/system-codex-home')
    })

    describe('daemon-active provider (parity with LocalPtyProvider)', () => {
      // Why: these tests guard the regression the daemon-parity refactor was
      // written to fix — under the daemon, LocalPtyProvider.buildSpawnEnv is
      // never invoked, so every host-local env injection must happen inside
      // the pty:spawn IPC handler instead. Before the refactor, only the
      // hook server env and attribution shims were injected on this path;
      // OpenCode plugin dir, Pi overlay, Codex home, and dev-mode CLI
      // overrides were silently missing for daemon users (the common case).

      function setupDaemonAdapter() {
        const daemonSpawn = vi.fn(
          async (options: { env: Record<string, string>; sessionId?: string }) => ({
            id: options.sessionId ?? 'daemon-pty'
          })
        )
        setLocalPtyProvider({
          spawn: daemonSpawn,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          shutdown: vi.fn(),
          onData: vi.fn(() => vi.fn()),
          onExit: vi.fn(() => vi.fn()),
          listProcesses: vi.fn(async () => []),
          getForegroundProcess: vi.fn(async () => null)
        } as never)
        return daemonSpawn
      }

      async function daemonSpawnAndGetEnv(
        argsEnv?: Record<string, string>,
        getSelectedCodexHomePath?: () => string | null,
        getSettings?: () => { enableGitHubAttribution: boolean },
        processEnvOverrides?: Record<string, string | undefined>
      ): Promise<Record<string, string>> {
        const daemonSpawn = setupDaemonAdapter()
        const savedEnv: Record<string, string | undefined> = {}
        if (processEnvOverrides) {
          for (const [k, v] of Object.entries(processEnvOverrides)) {
            savedEnv[k] = process.env[k]
            if (v === undefined) {
              delete process.env[k]
            } else {
              process.env[k] = v
            }
          }
        }
        try {
          handlers.clear()
          registerPtyHandlers(
            mainWindow as never,
            undefined,
            getSelectedCodexHomePath,
            getSettings as never
          )
          await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            ...(argsEnv ? { env: argsEnv } : {})
          })
          return daemonSpawn.mock.calls.at(-1)![0].env
        } finally {
          for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) {
              delete process.env[k]
            } else {
              process.env[k] = v
            }
          }
        }
      }

      it('injects OpenCode plugin env (OPENCODE_CONFIG_DIR) on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({}, undefined, undefined, {
          OPENCODE_CONFIG_DIR: undefined
        })
        expect(openCodeBuildPtyEnvMock).toHaveBeenCalled()
        expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-config')
        expect(env.ORCA_OPENCODE_HOOK_PORT).toBe('4567')
      })

      it('mirrors a user-provided OPENCODE_CONFIG_DIR into a per-PTY overlay on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({ OPENCODE_CONFIG_DIR: '/user/custom/opencode' })
        // Why: OpenCode loads config from a single dir, so the user's path is
        // mirrored into a per-PTY overlay rather than passed through literally.
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

      it('injects Pi overlay env (PI_CODING_AGENT_DIR) on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({ PI_CODING_AGENT_DIR: '/user/.pi/agent' })
        // Why: asserts the overlay key was passed through — the id is the
        // daemon-assigned sessionId minted in pty.ts, and the mock returns
        // the fixed overlay path from the shared setup.
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), '/user/.pi/agent')
        expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/orca-pi-agent-overlay')
        expect(env.ORCA_PI_CODING_AGENT_DIR).toBe('/tmp/orca-pi-agent-overlay')
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/user/.pi/agent')
      })

      it('injects the selected Codex home on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({}, () => '/tmp/orca-codex-home')
        expect(env.CODEX_HOME).toBe('/tmp/orca-codex-home')
      })

      it('injects the agent-hook receiver env on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({})
        expect(env.ORCA_AGENT_HOOK_PORT).toBe('5678')
        expect(env.ORCA_AGENT_HOOK_TOKEN).toBe('agent-token')
      })

      it('prepends attribution shims on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({}, undefined, () => ({
          enableGitHubAttribution: true
        }))
        expect(env.ORCA_ENABLE_GIT_ATTRIBUTION).toBe('1')
        expect(env.PATH).toContain('/tmp/orca-user-data/orca-terminal-attribution/posix')
      })

      it('injects dev-mode ORCA_USER_DATA_PATH + dev CLI PATH on the daemon path', async () => {
        // Why: the mocked `app` (see vi.mock at the top of the file) is a
        // plain object, so we can flip isPackaged for the scope of the test.
        const { app } = await import('electron')
        const mockedApp = app as unknown as { isPackaged: boolean }
        const prev = mockedApp.isPackaged
        mockedApp.isPackaged = false
        try {
          const env = await daemonSpawnAndGetEnv({ PATH: '/usr/bin' })
          expect(env.ORCA_USER_DATA_PATH).toBe('/tmp/orca-user-data')
          expect(env.PATH).toContain('/tmp/orca-user-data/cli/bin')
        } finally {
          mockedApp.isPackaged = prev
        }
      })

      it('passes the minted sessionId through to provider.spawn so the Pi overlay is keyed on a stable id', async () => {
        const daemonSpawn = setupDaemonAdapter()
        handlers.clear()
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          env: {}
        })
        const spawnOpts = daemonSpawn.mock.calls.at(-1)![0]
        const sessionId = spawnOpts.sessionId
        expect(sessionId).toEqual(expect.any(String))
        expect((sessionId ?? '').length).toBeGreaterThan(0)
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(sessionId, undefined)
      })

      it('respects a caller-provided sessionId instead of minting a new one', async () => {
        const daemonSpawn = setupDaemonAdapter()
        handlers.clear()
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          env: {},
          sessionId: 'user-session-42'
        })
        expect(daemonSpawn.mock.calls.at(-1)![0].sessionId).toBe('user-session-42')
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith('user-session-42', undefined)
      })

      it('prefixes a minted sessionId with the worktreeId when provided', async () => {
        // Why: daemon reconnect keys Pi overlay and live-shell survival on the
        // sessionId. Prefixing with worktreeId lets the daemon scope sessions
        // by worktree while still minting a unique tail. The format contract
        // is `${worktreeId}@@${8-char-hex}` and must not regress.
        const daemonSpawn = setupDaemonAdapter()
        handlers.clear()
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          env: {},
          worktreeId: 'wt-alpha'
        })
        const sessionId = daemonSpawn.mock.calls.at(-1)![0].sessionId ?? ''
        expect(sessionId).toMatch(/^wt-alpha@@[0-9a-f]{8}$/)
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(sessionId, undefined)
      })

      it('falls back to process.env.PI_CODING_AGENT_DIR when baseEnv lacks it on the daemon path', async () => {
        // Why: buildPtyHostEnv reads `baseEnv.X ?? process.env.X` so the
        // existing-agent-dir guard stays consistent whether Pi's env was
        // carried on the IPC wire or inherited by the daemon via fork. The
        // fallback must reach piTitlebarExtensionService.buildPtyEnv as the
        // second arg so the overlay preserves the user's existing root.
        const env = await daemonSpawnAndGetEnv({}, undefined, undefined, {
          PI_CODING_AGENT_DIR: '/ambient/pi/agent'
        })
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), '/ambient/pi/agent')
        expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/orca-pi-agent-overlay')
        expect(env.ORCA_PI_CODING_AGENT_DIR).toBe('/tmp/orca-pi-agent-overlay')
      })

      it('skips attribution shims on the daemon path when the setting is disabled', async () => {
        const env = await daemonSpawnAndGetEnv({ PATH: '/usr/bin' }, undefined, () => ({
          enableGitHubAttribution: false
        }))
        expect(env.ORCA_ENABLE_GIT_ATTRIBUTION).toBeUndefined()
        expect(env.PATH ?? '').not.toContain('/tmp/orca-user-data/orca-terminal-attribution/posix')
      })

      it('does not mutate the caller-provided args.env on the daemon path', async () => {
        // Why: the handler clones baseEnv before calling buildPtyHostEnv so
        // IPC-provided env stays pristine. A regression would silently leak
        // Orca host env (hook tokens, overlay paths) back into the renderer's
        // copy of the object, which it may reuse for unrelated IPC calls.
        const daemonSpawn = setupDaemonAdapter()
        const argsEnv: Record<string, string> = { FOO: 'bar' }
        handlers.clear()
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          env: argsEnv
        })
        expect(argsEnv).toEqual({ FOO: 'bar' })
        // Sanity: the spawn did receive the injected env, proving the test
        // isn't passing because buildPtyHostEnv never ran.
        const spawnEnv = daemonSpawn.mock.calls.at(-1)![0].env
        expect(spawnEnv.ORCA_AGENT_HOOK_PORT).toBe('5678')
        expect(spawnEnv).not.toBe(argsEnv)
      })

      it('rejects a caller-supplied sessionId that escapes userData via ..', async () => {
        // Why: effectiveSessionId is used as a Pi overlay directory key under
        // userData. A crafted IPC payload with a traversal sequence must be
        // refused before any filesystem side-effects run.
        const daemonSpawn = setupDaemonAdapter()
        handlers.clear()
        registerPtyHandlers(mainWindow as never)
        await expect(
          handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            env: {},
            sessionId: '../etc/passwd'
          })
        ).rejects.toThrow(/Invalid PTY session id/)
        expect(daemonSpawn).not.toHaveBeenCalled()
        expect(piBuildPtyEnvMock).not.toHaveBeenCalled()
      })

      it('sweeps per-PTY state when provider.spawn fails for a MINTED sessionId', async () => {
        // Why: buildPtyHostEnv has filesystem side-effects (Pi overlay
        // materialization). If provider.spawn later fails, the overlay would
        // leak. The handler should clear per-PTY state for the minted id so
        // it isn't orphaned.
        const daemonSpawn = vi.fn(async () => {
          throw new Error('spawn boom')
        })
        setLocalPtyProvider({
          spawn: daemonSpawn,
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
        await expect(
          handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
        ).rejects.toThrow(/spawn boom/)
        expect(openCodeClearPtyMock).toHaveBeenCalled()
        expect(piClearPtyMock).toHaveBeenCalled()
      })

      it('does NOT sweep per-PTY state on provider.spawn failure for CALLER-supplied sessionId', async () => {
        // Why: a caller-supplied sessionId may refer to an existing PTY whose
        // state (OpenCode hooks, Pi overlay, agent-hook pane caches) must not
        // be clobbered on a retry/attach failure. Only minted ids get swept.
        const daemonSpawn = vi.fn(async () => {
          throw new Error('spawn boom')
        })
        setLocalPtyProvider({
          spawn: daemonSpawn,
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
        await expect(
          handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            env: {},
            sessionId: 'caller-owned-session'
          })
        ).rejects.toThrow(/spawn boom/)
        expect(openCodeClearPtyMock).not.toHaveBeenCalled()
        expect(piClearPtyMock).not.toHaveBeenCalled()
      })

      it('does NOT inject host-local env on SSH spawns (connectionId set)', async () => {
        const sshSpawn = vi.fn(async (_opts: { env: Record<string, string> }) => ({
          id: 'ssh-pty'
        }))
        const store = {
          upsertSshRemotePtyLease: vi.fn(),
          persistPtyBinding: vi.fn()
        }
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
        registerPtyHandlers(
          mainWindow as never,
          undefined,
          undefined,
          undefined,
          undefined,
          store as never
        )
        const leafId = '11111111-1111-4111-8111-111111111111'
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          env: { FOO: 'bar', ORCA_PANE_KEY: makePaneKey('tab-1', leafId) },
          connectionId: 'ssh-1',
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId
        })
        const env = sshSpawn.mock.calls.at(-1)![0].env
        // Why: every host-local var must be absent over SSH — the hook
        // server is on the Orca host's 127.0.0.1, dev CLI / attribution /
        // overlay / plugin-dir paths only exist on the local disk, so
        // shipping any of them to a remote shell is at best useless and at
        // worst a credential leak.
        expect(env.ORCA_AGENT_HOOK_PORT).toBeUndefined()
        expect(env.ORCA_AGENT_HOOK_TOKEN).toBeUndefined()
        expect(env.ORCA_ENABLE_GIT_ATTRIBUTION).toBeUndefined()
        expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
        expect(env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
        expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
        expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
        expect(env.CODEX_HOME).toBeUndefined()
        expect(env.FOO).toBe('bar')
        expect(openCodeBuildPtyEnvMock).not.toHaveBeenCalled()
        expect(piBuildPtyEnvMock).not.toHaveBeenCalled()
        expect(store.upsertSshRemotePtyLease).toHaveBeenCalledWith(
          expect.objectContaining({
            targetId: 'ssh-1',
            ptyId: 'ssh-pty',
            worktreeId: 'wt-1',
            tabId: 'tab-1',
            leafId,
            state: 'attached'
          })
        )
        expect(store.persistPtyBinding).toHaveBeenCalledWith({
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId,
          ptyId: 'ssh-pty'
        })

        store.upsertSshRemotePtyLease.mockClear()
        store.persistPtyBinding.mockClear()
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          env: { ORCA_PANE_KEY: 'tab-1:pane:1' },
          connectionId: 'ssh-1',
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId: 'pane:1'
        })
        expect(store.upsertSshRemotePtyLease).toHaveBeenCalledTimes(1)
        expect(sshSpawn.mock.calls.at(-1)?.[0].env.ORCA_PANE_KEY).toBeUndefined()
        expect(store.upsertSshRemotePtyLease.mock.calls[0]?.[0]).not.toHaveProperty('leafId')
        expect(store.persistPtyBinding).not.toHaveBeenCalled()
      })

      it('marks a caller-supplied SSH session expired when remote reattach is gone', async () => {
        const sshSpawn = vi.fn(async () => {
          throw new Error('SSH_SESSION_EXPIRED: remote-pty')
        })
        const store = {
          markSshRemotePtyLease: vi.fn()
        }
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
        registerPtyHandlers(
          mainWindow as never,
          undefined,
          undefined,
          undefined,
          undefined,
          store as never
        )

        await expect(
          handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            env: {},
            connectionId: 'ssh-1',
            sessionId: 'remote-pty'
          })
        ).rejects.toThrow('SSH_SESSION_EXPIRED: remote-pty')

        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'remote-pty', 'expired')
      })

      it('does not tombstone an SSH lease when explicit kill shutdown fails transiently', async () => {
        const store = {
          markSshRemotePtyLease: vi.fn()
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
          markSshRemotePtyLease: vi.fn()
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
        await Promise.resolve()

        expect(shutdown).toHaveBeenCalledWith('remote-pty', { immediate: false })
        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith(
          'ssh-1',
          'remote-pty',
          'terminated'
        )
        expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', -1)
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

        expect(controller.kill('remote-pty')).toBe(true)

        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith(
          'ssh-1',
          'remote-pty',
          'terminated'
        )
        expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', -1)
      })

      it('preserves an SSH lease when runtime controller kill shutdown fails transiently', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const store = {
          markSshRemotePtyLease: vi.fn()
        }
        const runtime = {
          setPtyController: vi.fn(),
          onPtyExit: vi.fn()
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
        }

        try {
          expect(controller.kill('remote-pty')).toBe(true)
          await Promise.resolve()
        } finally {
          warnSpy.mockRestore()
          deletePtyOwnership('remote-pty')
        }

        expect(store.markSshRemotePtyLease).not.toHaveBeenCalledWith(
          'ssh-1',
          'remote-pty',
          'terminated'
        )
        expect(runtime.onPtyExit).not.toHaveBeenCalled()
      })

      it('strips ORCA_PANE_KEY/TAB_ID/WORKTREE_ID from SSH spawn env when feature flag is off', async () => {
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
          // Why: the local hook server's userData-relative endpoint file path
          // is meaningless on the remote box; assert it does not leak.
          expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
        } finally {
          if (prevFlag === undefined) {
            delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
          } else {
            process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = prevFlag
          }
        }
      })

      it('forwards ORCA_PANE_KEY/TAB_ID/WORKTREE_ID over SSH when feature flag is on', async () => {
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
        process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
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
          // Local hook server coords still must NOT cross the wire — the
          // relay is the source of truth for those.
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

  it('rethrows non-not-found local provider shutdown failures', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn().mockRejectedValue(new Error('daemon unavailable')),
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

    await expect(handlers.get('pty:kill')!(null, { id: 'local-pty' })).rejects.toThrow(
      'daemon unavailable'
    )
  })

  it('lists sessions from both local and SSH providers', async () => {
    registerPtyHandlers(mainWindow as never)
    const sshListProcesses = vi.fn(async () => [
      { id: 'remote-pty', cwd: '/remote', title: 'ssh-shell' }
    ])
    const sshShutdown = vi.fn(async () => undefined)
    registerSshPtyProvider('ssh-1', {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: sshShutdown,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: sshListProcesses,
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })
    const sessions = (await handlers.get('pty:listSessions')!(null, undefined)) as {
      id: string
      cwd: string
      title: string
    }[]

    expect(sshListProcesses).toHaveBeenCalled()
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cwd: '/remote', id: 'remote-pty', title: 'ssh-shell' })
      ])
    )

    await handlers.get('pty:kill')!(null, { id: 'remote-pty' })
    expect(sshShutdown).toHaveBeenCalledWith('remote-pty', {
      immediate: true,
      keepHistory: false
    })
  })

  it('ignores fire-and-forget IPC for detached SSH PTYs without a provider', async () => {
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    }
    const provider = {
      spawn: vi.fn(async () => ({ id: 'remote-pty' })),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(async () => undefined),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    }
    registerSshPtyProvider('ssh-1', provider as never)
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      store as never
    )
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      connectionId: 'ssh-1',
      env: {}
    })
    unregisterSshPtyProvider('ssh-1')
    const listenerFor = (channel: string): ((event: unknown, args: unknown) => void) => {
      const call = onMock.mock.calls.find((entry: unknown[]) => entry[0] === channel)
      if (!call) {
        throw new Error(`missing ${channel} listener`)
      }
      return call[1] as (event: unknown, args: unknown) => void
    }

    expect(() => listenerFor('pty:write')(null, { id: 'remote-pty', data: 'x' })).not.toThrow()
    expect(() =>
      listenerFor('pty:resize')(null, { id: 'remote-pty', cols: 100, rows: 30 })
    ).not.toThrow()
    expect(() => listenerFor('pty:ackColdRestore')(null, { id: 'remote-pty' })).not.toThrow()
    expect(() =>
      listenerFor('pty:signal')(null, { id: 'remote-pty', signal: 'SIGINT' })
    ).not.toThrow()

    await expect(handlers.get('pty:kill')!(null, { id: 'remote-pty' })).resolves.toBeUndefined()
    expect(store.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'remote-pty', 'terminated')
  })

  it('injects ORCA_TERMINAL_HANDLE for non-local PTY providers', async () => {
    const spawn = vi.fn(async () => ({ id: 'remote-pty' }))
    registerSshPtyProvider('ssh-1', {
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn(),
      acknowledgeDataEvent: vi.fn()
    } as never)
    const runtime = {
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn()
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      connectionId: 'ssh-1',
      env: { EXISTING: '1' }
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          EXISTING: '1',
          ORCA_TERMINAL_HANDLE: 'term_remote'
        })
      })
    )
    expect(runtime.registerPreAllocatedHandleForPty).toHaveBeenCalledWith(
      'remote-pty',
      'term_remote'
    )
  })

  it('reuses the runtime background handle in local PTY spawn env', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        preAllocatedHandle?: string
      }): Promise<{ id: string }>
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      preAllocateHandleForPty: vi.fn(() => 'term_wrong'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    expect(controller).not.toBeNull()
    const spawnController = controller as unknown as RuntimeSpawnController
    await spawnController.spawn({
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      preAllocatedHandle: 'term_expected'
    })

    const spawnCall = spawnMock.mock.calls.at(-1)!
    const env = spawnCall[2].env as Record<string, string>
    expect(env.ORCA_TERMINAL_HANDLE).toBe('term_expected')
    expect(runtime.preAllocateHandleForPty).not.toHaveBeenCalled()
    expect(runtime.registerPreAllocatedHandleForPty).toHaveBeenCalledWith(
      expect.any(String),
      'term_expected'
    )
  })

  it('maps runtime-owned spawn paneKeys for renderer serializer settlement', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        env?: Record<string, string>
      }): Promise<{ id: string }>
      hasRendererSerializer?(ptyId: string): boolean
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      preAllocateHandleForPty: vi.fn(() => 'term_trusted'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    const paneKey = makePaneKey('tab-cli', '11111111-1111-4111-8111-111111111111')
    const gen = (await handlers.get('pty:declarePendingPaneSerializer')!(null, {
      paneKey
    })) as number
    const spawnController = controller as unknown as RuntimeSpawnController
    const result = await spawnController.spawn({
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      env: { ORCA_PANE_KEY: ` ${paneKey} ` }
    })

    expect(spawnController.hasRendererSerializer?.(result.id)).toBe(false)
    await handlers.get('pty:settlePaneSerializer')!(null, { paneKey, gen })
    expect(spawnController.hasRendererSerializer?.(result.id)).toBe(true)
  })

  it('ignores renderer-provided ORCA_TERMINAL_HANDLE for local PTY spawns', async () => {
    const runtime = {
      setPtyController: vi.fn(),
      preAllocateHandleForPty: vi.fn(() => 'term_trusted'),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      env: { ORCA_TERMINAL_HANDLE: 'term_untrusted' }
    })

    const spawnCall = spawnMock.mock.calls.at(-1)!
    const env = spawnCall[2].env as Record<string, string>
    expect(env.ORCA_TERMINAL_HANDLE).toBe('term_trusted')
    expect(runtime.preAllocateHandleForPty).toHaveBeenCalledWith(expect.any(String))
  })

  describe('Windows UTF-8 code page', () => {
    let originalPlatform: string
    let originalComspec: string | undefined

    beforeEach(() => {
      originalPlatform = process.platform
      originalComspec = process.env.COMSPEC
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })
      process.env.USERPROFILE = 'C:\\Users\\test'
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalComspec === undefined) {
        delete process.env.COMSPEC
      } else {
        process.env.COMSPEC = originalComspec
      }
      delete process.env.PYTHONUTF8
    })

    it('passes chcp 65001 to cmd.exe for UTF-8 console output', () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Windows\\system32\\cmd.exe',
        ['/K', 'chcp 65001 > nul'],
        expect.any(Object)
      )
    })

    it('sets Console encoding for powershell.exe', () => {
      process.env.COMSPEC = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })

    it('sets Console encoding for pwsh.exe', () => {
      process.env.COMSPEC = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })

    it('sets PYTHONUTF8=1 in the spawn environment on Windows', () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      const env = spawnCall[2].env as Record<string, string>
      expect(env.PYTHONUTF8).toBe('1')
    })

    it('does not override an existing PYTHONUTF8 value', () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      process.env.PYTHONUTF8 = '0'

      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      const env = spawnCall[2].env as Record<string, string>
      expect(env.PYTHONUTF8).toBe('0')
    })

    it('passes no encoding args for unrecognized shells', () => {
      process.env.COMSPEC = 'C:\\Program Files\\Git\\bin\\bash.exe'

      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        [],
        expect.any(Object)
      )
    })

    it('uses terminalWindowsShell setting over COMSPEC when provided', () => {
      // Why: COMSPEC always points to cmd.exe on stock Windows, so without the
      // setting the terminal would ignore the user's shell preference.
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe'
          }) as never
      )
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'powershell.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })

    it('spawns powershell.exe when PowerShell family keeps the inbox implementation', () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsPowerShellImplementation: 'powershell.exe'
          }) as never
      )
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'powershell.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })

    it('spawns pwsh.exe when PowerShell 7 is selected and available', () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      isPwshAvailableMock.mockReturnValue(true)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith('pwsh.exe', POWERSHELL_OSC133_ARGS, expect.any(Object))
    })

    it('falls back to powershell.exe when PowerShell 7 is selected but unavailable', () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      isPwshAvailableMock.mockReturnValue(false)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'powershell.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })

    it('falls back to powershell.exe when shellOverride requests pwsh.exe but pwsh is unavailable', () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      isPwshAvailableMock.mockReturnValue(false)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, shellOverride: 'pwsh.exe' })

      expect(spawnMock).toHaveBeenCalledWith(
        'powershell.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })

    it('ignores the PowerShell implementation setting for cmd.exe', () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\powershell.exe'
      isPwshAvailableMock.mockReturnValue(true)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'cmd.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'cmd.exe',
        ['/K', 'chcp 65001 > nul'],
        expect.any(Object)
      )
    })

    it('ignores the PowerShell implementation setting for wsl.exe', () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\powershell.exe'
      isPwshAvailableMock.mockReturnValue(true)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'wsl.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith('wsl.exe', expect.any(Array), expect.any(Object))
    })

    it('keeps shellOverride priority for one-off tabs', () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      isPwshAvailableMock.mockReturnValue(false)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe'
      })

      expect(spawnMock).toHaveBeenCalledWith('wsl.exe', expect.any(Array), expect.any(Object))
    })
  })

  it('rejects missing WSL worktree cwd instead of validating only the fallback Windows cwd', async () => {
    const originalPlatform = process.platform
    const originalUserProfile = process.env.USERPROFILE

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    process.env.USERPROFILE = 'C:\\Users\\jinwo'

    existsSyncMock.mockImplementation((targetPath: string) => {
      if (targetPath === '\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing') {
        return false
      }
      return true
    })

    try {
      registerPtyHandlers(mainWindow as never)

      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing'
        })
      ).rejects.toThrow(
        'Working directory "\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing" does not exist.'
      )
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE
      } else {
        process.env.USERPROFILE = originalUserProfile
      }
    }
  })

  it('spawns a plain POSIX login shell and queues startup commands for the live session', () => {
    const originalPlatform = process.platform
    const originalShell = process.env.SHELL
    const originalZdotdir = process.env.ZDOTDIR

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    process.env.SHELL = '/bin/zsh'
    delete process.env.ZDOTDIR

    try {
      const [shell, args, options] = spawnAndGetCall({ cwd: '/tmp', command: 'printf "hello"' })
      expect(shell).toBe('/bin/zsh')
      expect(args).toEqual(['-l'])
      expect(options.env.ZDOTDIR).toBe('/tmp/orca-user-data/shell-ready/zsh')
      expect(options.env.ORCA_ORIG_ZDOTDIR).toBe(process.env.HOME)
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
      if (originalZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = originalZdotdir
      }
    }
  })

  it('uses the POSIX shell wrapper so OpenCode config survives shell startup files', () => {
    const originalPlatform = process.platform
    const originalShell = process.env.SHELL

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    process.env.SHELL = '/bin/zsh'

    try {
      const [shell, args, options] = spawnAndGetCall({ cwd: '/tmp' })
      expect(shell).toBe('/bin/zsh')
      expect(args).toEqual(['-l'])
      expect(options.env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-config')
      expect(options.env.ORCA_OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-config')
      expect(options.env.ZDOTDIR).toBe('/tmp/orca-user-data/shell-ready/zsh')
      expect(options.env.ORCA_SHELL_READY_MARKER).toBe('0')
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })

  it('uses the POSIX shell wrapper so Pi config survives shell startup files', () => {
    const originalPlatform = process.platform
    const originalShell = process.env.SHELL

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    process.env.SHELL = '/bin/zsh'
    openCodeBuildPtyEnvMock.mockImplementationOnce(() => ({
      ORCA_OPENCODE_HOOK_PORT: '4567',
      ORCA_OPENCODE_HOOK_TOKEN: 'opencode-token',
      ORCA_OPENCODE_PTY_ID: 'test-pty'
    }))

    try {
      const [shell, args, options] = spawnAndGetCall({
        cwd: '/tmp',
        env: { PI_CODING_AGENT_DIR: '/tmp/user-pi-agent' }
      })
      expect(shell).toBe('/bin/zsh')
      expect(args).toEqual(['-l'])
      expect(options.env.OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(options.env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(options.env.PI_CODING_AGENT_DIR).toBe('/tmp/orca-pi-agent-overlay')
      expect(options.env.ORCA_PI_CODING_AGENT_DIR).toBe('/tmp/orca-pi-agent-overlay')
      expect(options.env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/tmp/user-pi-agent')
      expect(options.env.ZDOTDIR).toBe('/tmp/orca-user-data/shell-ready/zsh')
      expect(options.env.ORCA_SHELL_READY_MARKER).toBe('0')
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })

  it('does not force ~/.bashrc after sourcing bash login files in the shell-ready rcfile', async () => {
    const originalPlatform = process.platform
    const originalShell = process.env.SHELL

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    process.env.SHELL = '/bin/bash'

    try {
      spawnAndGetCall({ cwd: '/tmp', command: 'echo hello' })

      const { getBashShellReadyRcfileContent } = await import('./pty')
      const bashRcContent = getBashShellReadyRcfileContent()
      expect(bashRcContent).toContain('source "$HOME/.bash_profile"')
      expect(bashRcContent).not.toContain('source "$HOME/.bashrc"')
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })

  it('does not write the startup command before the shell-ready marker arrives', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        command: 'claude'
      })

      expect(mockProc.proc.write).not.toHaveBeenCalled()

      mockProc.emitData('last login: today\r\n')
      vi.runOnlyPendingTimers()
      expect(mockProc.proc.write).not.toHaveBeenCalled()

      mockProc.emitData('\x1b]133;A\x07% ')
      await Promise.resolve()
      vi.runAllTimers()
      expect(mockProc.proc.write).toHaveBeenCalledWith('claude\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to a max wait when the shell emits no readiness output', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        command: 'codex'
      })

      vi.advanceTimersByTime(1500)
      await Promise.resolve()
      vi.runAllTimers()
      expect(mockProc.proc.write).toHaveBeenCalledWith('codex\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to a system shell when SHELL points to a missing binary', async () => {
    const originalShell = process.env.SHELL
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    existsSyncMock.mockImplementation(
      (targetPath: string) => targetPath !== '/opt/homebrew/bin/bash'
    )

    try {
      process.env.SHELL = '/opt/homebrew/bin/bash'

      registerPtyHandlers(mainWindow as never)
      const result = await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })

      expect(result).toEqual({ id: expect.any(String), pid: 12345 })
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(spawnMock).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l'],
        expect.objectContaining({ cwd: '/tmp' })
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

  it('falls back when SHELL points to a non-executable binary', async () => {
    const originalShell = process.env.SHELL
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    accessSyncMock.mockImplementation((targetPath: string) => {
      if (targetPath === '/opt/homebrew/bin/bash') {
        throw new Error('permission denied')
      }
    })

    try {
      process.env.SHELL = '/opt/homebrew/bin/bash'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })

      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(spawnMock).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l'],
        expect.objectContaining({
          cwd: '/tmp',
          env: expect.objectContaining({
            ORCA_OPENCODE_CONFIG_DIR: '/tmp/orca-opencode-config',
            ORCA_SHELL_READY_MARKER: '0',
            ZDOTDIR: '/tmp/orca-user-data/shell-ready/zsh'
          })
        })
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Shell "/opt/homebrew/bin/bash" is not executable')
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

  it('upgrades legacy numeric pane keys when the spawn metadata proves the stable leaf', async () => {
    registerPtyHandlers(mainWindow as never)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const stablePaneKey = makePaneKey('tab-1', leafId)
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId,
      env: { ORCA_PANE_KEY: 'tab-1:0' }
    })

    expect(registerPtyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paneKey: stablePaneKey
      })
    )
    expect(registerPaneKeyAliasMock).toHaveBeenCalledWith(
      'tab-1:0',
      stablePaneKey,
      expect.any(String)
    )
    expect(clearMigrationUnsupportedPtysForPaneKeyMock).toHaveBeenCalledWith(stablePaneKey)
    expect(setMigrationUnsupportedPtyMock).not.toHaveBeenCalled()

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId,
      env: { ORCA_PANE_KEY: stablePaneKey }
    })

    expect(registerPtyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paneKey: stablePaneKey
      })
    )
    expect(clearMigrationUnsupportedPtysForPaneKeyMock).toHaveBeenCalledWith(stablePaneKey)

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId,
      env: { ORCA_PANE_KEY: makePaneKey('tab-2', leafId) }
    })

    expect(registerPtyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paneKey: null
      })
    )
  })

  it('does not let an old PTY teardown clear a newer pane-key owner', async () => {
    registerPtyHandlers(mainWindow as never)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const stablePaneKey = makePaneKey('tab-1', leafId)

    const first = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId,
      env: { ORCA_PANE_KEY: stablePaneKey }
    })) as { id: string }
    const second = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId,
      env: { ORCA_PANE_KEY: stablePaneKey }
    })) as { id: string }

    expect(getPtyIdForPaneKey(stablePaneKey)).toBe(second.id)
    clearAgentHookPaneStateMock.mockClear()
    clearProviderPtyState(first.id)

    expect(getPtyIdForPaneKey(stablePaneKey)).toBe(second.id)
    expect(clearAgentHookPaneStateMock).not.toHaveBeenCalledWith(stablePaneKey)

    clearProviderPtyState(second.id)
    expect(getPtyIdForPaneKey(stablePaneKey)).toBeUndefined()
    expect(clearAgentHookPaneStateMock).toHaveBeenCalledWith(stablePaneKey)
  })

  it('does not let restart-era alias cleanup clear a newer pane-key owner', async () => {
    registerPtyHandlers(mainWindow as never)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const stablePaneKey = makePaneKey('tab-1', leafId)

    const current = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId,
      env: { ORCA_PANE_KEY: stablePaneKey }
    })) as { id: string }

    expect(getPtyIdForPaneKey(stablePaneKey)).toBe(current.id)
    clearPaneKeyAliasesForPtyMock.mockClear()

    clearProviderPtyState('old-pty-without-forward-pane-key')

    const cleanupOptions = clearPaneKeyAliasesForPtyMock.mock.calls.find(
      ([ptyId]) => ptyId === 'old-pty-without-forward-pane-key'
    )?.[1]
    expect(cleanupOptions?.shouldClearStablePaneKey(stablePaneKey)).toBe(false)
  })

  it('prefers args.env.SHELL and normalizes the child env after fallback', async () => {
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
            ORCA_SHELL_READY_MARKER: '0',
            ZDOTDIR: '/tmp/orca-user-data/shell-ready/zsh'
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

  it('disposes PTY listeners before manual kill IPC', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()
    // Why: hold a stable reference to the kill spy. On POSIX, destroyPtyProcess
    // in local-pty-provider reassigns proc.kill to a no-op to defuse the
    // SIGHUP-to-recycled-pid hazard (see docs/fix-pty-fd-leak.md). Reading
    // proc.kill.mock after that runs would yield a non-mock and crash.
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn(() => onExitDisposable),
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

    await handlers.get('pty:kill')!(null, { id: spawnResult.id })

    expect(onDataDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killSpy.mock.invocationCallOrder[0]
    )
    expect(onExitDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killSpy.mock.invocationCallOrder[0]
    )
  })

  it('disposes PTY listeners before runtime controller kill', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn(() => onExitDisposable),
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

    registerPtyHandlers(mainWindow as never, runtime as never)
    const spawnResult = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const runtimeController = runtime.setPtyController.mock.calls[0]?.[0] as {
      kill: (ptyId: string) => boolean
    }

    expect(runtimeController.kill(spawnResult.id)).toBe(true)
    expect(onDataDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killSpy.mock.invocationCallOrder[0]
    )
    expect(onExitDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killSpy.mock.invocationCallOrder[0]
    )
  })

  it('disposes PTY listeners before did-finish-load orphan cleanup', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn(() => onExitDisposable),
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

    registerPtyHandlers(mainWindow as never, runtime as never)
    const didFinishLoad = mainWindow.webContents.on.mock.calls.find(
      ([eventName]) => eventName === 'did-finish-load'
    )?.[1] as (() => void) | undefined
    expect(didFinishLoad).toBeTypeOf('function')
    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    // The first load after spawn only advances generation. The second one sees
    // this PTY as belonging to a prior page load and kills it as orphaned.
    didFinishLoad?.()
    didFinishLoad?.()

    expect(onDataDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killSpy.mock.invocationCallOrder[0]
    )
    expect(onExitDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killSpy.mock.invocationCallOrder[0]
    )
  })

  it('clears PTY state even when kill reports the process is already gone', async () => {
    const proc = {
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn(() => makeDisposable()),
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

    await handlers.get('pty:kill')!(null, { id: spawnResult.id })

    expect(await handlers.get('pty:hasChildProcesses')!(null, { id: spawnResult.id })).toBe(false)
    expect(openCodeClearPtyMock).toHaveBeenCalledWith(spawnResult.id)
    expect(piClearPtyMock).toHaveBeenCalledWith(spawnResult.id)
  })

  describe('agent_started telemetry', () => {
    // Why: telemetry-plan.md§Agent launch semantics — agent_started must
    // fire only after provider.spawn resolves. The renderer threads
    // launch metadata through `pty:spawn`; a missing or malformed
    // payload must not produce a silently-malformed event.
    it('emits agent_started after a successful spawn when telemetry is supplied', async () => {
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        telemetry: {
          agent_kind: 'claude-code',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        }
      })
      expect(trackMock).toHaveBeenCalledWith('agent_started', {
        agent_kind: 'claude-code',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      })
    })

    it('does not emit agent_started when telemetry is omitted (bare-shell tab)', async () => {
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })
      expect(trackMock).not.toHaveBeenCalled()
    })

    it('drops the event when any telemetry field is outside its closed enum', async () => {
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        telemetry: {
          agent_kind: 'claude-code',
          launch_source: 'not_a_real_surface',
          request_kind: 'new'
        }
      })
      expect(trackMock).not.toHaveBeenCalledWith('agent_started', expect.anything())
    })

    it('does not emit agent_started when provider.spawn throws', async () => {
      // Why: telemetry-plan contract is that agent_started fires only on
      // confirmed launch. Inject a provider whose spawn throws so we hit
      // the catch path with no race against the real LocalPtyProvider.
      setLocalPtyProvider({
        spawn: vi.fn(async () => {
          throw new Error('spawn boom')
        }),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        shutdown: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        listProcesses: vi.fn(async () => []),
        getForegroundProcess: vi.fn(async () => null)
      } as never)
      classifyErrorMock.mockReturnValue({ error_class: 'unknown' })
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          command: 'claude',
          telemetry: {
            agent_kind: 'claude-code',
            launch_source: 'new_workspace_composer',
            request_kind: 'new'
          }
        })
      ).rejects.toThrow(/spawn boom/)
      expect(trackMock).not.toHaveBeenCalledWith('agent_started', expect.anything())
    })
  })

  describe('serializeBuffer dispatch', () => {
    type SerializeListener = (
      _event: unknown,
      args: {
        requestId?: string
        snapshot?: { data?: unknown; cols?: unknown; rows?: unknown; lastTitle?: unknown } | null
      }
    ) => void
    type SerializeController = {
      serializeBuffer: (
        ptyId: string,
        opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
      ) => Promise<{ data: string; cols: number; rows: number; lastTitle?: string } | null>
    }

    function setup(): { listener: SerializeListener; controller: SerializeController } {
      const runtime = {
        setPtyController: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyData: vi.fn(),
        onPtyExit: vi.fn(),
        preAllocateHandleForPty: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const onCall = onMock.mock.calls.find(
        (call: unknown[]) => call[0] === 'pty:serializeBuffer:response'
      )
      if (!onCall) {
        throw new Error('expected pty:serializeBuffer:response listener registration')
      }
      const listener = onCall[1] as SerializeListener
      const controller = runtime.setPtyController.mock.calls[0]?.[0] as SerializeController
      return { listener, controller }
    }

    function getSentRequestIds(): string[] {
      return mainWindow.webContents.send.mock.calls
        .filter((call: unknown[]) => call[0] === 'pty:serializeBuffer:request')
        .map((call: unknown[]) => (call[1] as { requestId: string }).requestId)
    }

    it('registers exactly one persistent listener regardless of concurrent in-flight requests', async () => {
      const { listener, controller } = setup()
      const inflight = [
        controller.serializeBuffer('pty-1'),
        controller.serializeBuffer('pty-2'),
        controller.serializeBuffer('pty-3'),
        controller.serializeBuffer('pty-4'),
        controller.serializeBuffer('pty-5'),
        controller.serializeBuffer('pty-6'),
        controller.serializeBuffer('pty-7'),
        controller.serializeBuffer('pty-8'),
        controller.serializeBuffer('pty-9'),
        controller.serializeBuffer('pty-10'),
        controller.serializeBuffer('pty-11'),
        controller.serializeBuffer('pty-12')
      ]
      // Why: the bug being fixed registered one listener per request, so 12
      // concurrent calls would register 12 listeners and trip Node's MaxListeners.
      const responseChannelRegistrations = onMock.mock.calls.filter(
        (call: unknown[]) => call[0] === 'pty:serializeBuffer:response'
      )
      expect(responseChannelRegistrations.length).toBe(1)
      // Drain the in-flight requests so the test doesn't leak timers.
      for (const requestId of getSentRequestIds()) {
        listener(null, { requestId, snapshot: null })
      }
      await Promise.all(inflight)
    })

    it('routes each response to the originating request via requestId', async () => {
      const { listener, controller } = setup()
      const a = controller.serializeBuffer('pty-a')
      const b = controller.serializeBuffer('pty-b')
      const ids = getSentRequestIds()
      const requestIdA = ids[0]
      const requestIdB = ids[1]

      listener(null, {
        requestId: requestIdB,
        snapshot: { data: 'B-data', cols: 80, rows: 24 }
      })
      listener(null, {
        requestId: requestIdA,
        snapshot: { data: 'A-data', cols: 100, rows: 30, lastTitle: 'A-title' }
      })

      await expect(b).resolves.toEqual({ data: 'B-data', cols: 80, rows: 24 })
      await expect(a).resolves.toEqual({
        data: 'A-data',
        cols: 100,
        rows: 30,
        lastTitle: 'A-title'
      })
    })

    it('ignores responses with unknown requestId without affecting pending requests', async () => {
      const { listener, controller } = setup()
      const pending = controller.serializeBuffer('pty-1')
      const realRequestId = getSentRequestIds()[0]

      listener(null, {
        requestId: 'not-a-real-id',
        snapshot: { data: 'irrelevant', cols: 1, rows: 1 }
      })
      listener(null, { requestId: undefined, snapshot: null })

      let resolved = false
      void pending.then(() => {
        resolved = true
      })
      await new Promise((r) => setTimeout(r, 0))
      expect(resolved).toBe(false)

      listener(null, { requestId: realRequestId, snapshot: { data: 'ok', cols: 80, rows: 24 } })
      await expect(pending).resolves.toEqual({ data: 'ok', cols: 80, rows: 24 })
    })

    it('resolves to null and removes the entry when the 750ms timeout fires', async () => {
      vi.useFakeTimers()
      try {
        const { controller } = setup()
        const pending = controller.serializeBuffer('pty-stuck')
        vi.advanceTimersByTime(750)
        await expect(pending).resolves.toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('resolves to null when the response snapshot is malformed', async () => {
      const { listener, controller } = setup()
      const pending = controller.serializeBuffer('pty-bad')
      const requestId = getSentRequestIds()[0]
      listener(null, { requestId, snapshot: { data: 'ok', cols: 'not-a-number' } })
      await expect(pending).resolves.toBeNull()
    })
  })
})
