/* eslint-disable max-lines -- Why: PTY spawn env behavior is easiest to verify in
one focused file because the registration helper is stateful and each spawn-path
assertion reuses the same mocked IPC and node-pty harness. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { delimiter, join } from 'node:path'

const isWindowsHost = process.platform === 'win32'
const posixOnlyIt = isWindowsHost ? it.skip : it
const expectedOmpStatusExtension = '/tmp/default-omp-agent/extensions/orca-agent-status.ts'
const expectedAttributionShimDir = join(
  '/tmp/orca-user-data',
  'orca-terminal-attribution',
  isWindowsHost ? 'win32' : 'posix'
)

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
  nativeTheme: {
    shouldUseDarkColors: true
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
  getPtyRendererDeliveryDebugSnapshot,
  resetPtyRendererDeliveryDebug,
  getPtyIdForPaneKey,
  hasPendingRendererSerializerForPaneKey,
  setPtyOwnership,
  setLocalPtyProvider,
  rebindLocalProviderListeners,
  unregisterSshPtyProvider
} from './pty'
import { hasLiveClaudePtys, markClaudePtySpawned } from '../claude-accounts/live-pty-gate'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from '../powershell-osc133-bootstrap'
import { SSH_SESSION_EXPIRED_ERROR } from '../providers/ssh-pty-provider'
import { _resetWslCachesForTests, _setWslCachesForTests } from '../wsl'

const POWERSHELL_OSC133_ARGS = [
  '-NoLogo',
  '-NoExit',
  '-EncodedCommand',
  encodePowerShellCommand(getPowerShellOsc133Bootstrap())
]
const TEST_CODEX_HOME =
  process.platform === 'win32'
    ? 'C:\\Users\\test\\AppData\\Roaming\\orca\\codex-runtime-home\\home'
    : '/tmp/orca-codex-home'

function makeDisposable() {
  return { dispose: vi.fn() }
}

function makeDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
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
  const savedOrcaCodexHome = process.env.ORCA_CODEX_HOME
  const savedOrcaOmpAgentDir = process.env.ORCA_OMP_CODING_AGENT_DIR
  const savedOrcaOmpSourceAgentDir = process.env.ORCA_OMP_SOURCE_AGENT_DIR
  const savedOrcaOmpStatusExtension = process.env.ORCA_OMP_STATUS_EXTENSION
  const savedOrcaClaudeAgentStatusSettings = process.env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS

  beforeEach(() => {
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
    delete process.env.ORCA_OPENCODE_CONFIG_DIR
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    delete process.env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.ORCA_PI_SOURCE_AGENT_DIR
    delete process.env.ORCA_PI_CODING_AGENT_DIR
    delete process.env.ORCA_CODEX_HOME
    delete process.env.ORCA_OMP_SOURCE_AGENT_DIR
    delete process.env.ORCA_OMP_CODING_AGENT_DIR
    delete process.env.ORCA_OMP_STATUS_EXTENSION
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
    piBuildPtyEnvMock.mockImplementation(
      (_ptyId: string, existingAgentDir?: string, kind?: string) =>
        kind === 'omp'
          ? {
              ORCA_OMP_SOURCE_AGENT_DIR: existingAgentDir ?? '/tmp/default-omp-agent',
              ORCA_OMP_STATUS_EXTENSION: `${existingAgentDir ?? '/tmp/default-omp-agent'}/extensions/orca-agent-status.ts`
            }
          : {
              ORCA_PI_SOURCE_AGENT_DIR: existingAgentDir ?? '/tmp/default-pi-agent'
            }
    )
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
    _resetWslCachesForTests()
    vi.useRealTimers()
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
    if (savedOrcaCodexHome === undefined) {
      delete process.env.ORCA_CODEX_HOME
    } else {
      process.env.ORCA_CODEX_HOME = savedOrcaCodexHome
    }
    if (savedOrcaOmpAgentDir !== undefined) {
      process.env.ORCA_OMP_CODING_AGENT_DIR = savedOrcaOmpAgentDir
    } else {
      delete process.env.ORCA_OMP_CODING_AGENT_DIR
    }
    if (savedOrcaOmpSourceAgentDir !== undefined) {
      process.env.ORCA_OMP_SOURCE_AGENT_DIR = savedOrcaOmpSourceAgentDir
    } else {
      delete process.env.ORCA_OMP_SOURCE_AGENT_DIR
    }
    if (savedOrcaOmpStatusExtension !== undefined) {
      process.env.ORCA_OMP_STATUS_EXTENSION = savedOrcaOmpStatusExtension
    } else {
      delete process.env.ORCA_OMP_STATUS_EXTENSION
    }
    if (savedOrcaClaudeAgentStatusSettings === undefined) {
      delete process.env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS
    } else {
      process.env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS = savedOrcaClaudeAgentStatusSettings
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

  function getPtyWriteListener(): (event: unknown, args: { id: string; data: string }) => void {
    const writeCall = onMock.mock.calls.find((call: unknown[]) => call[0] === 'pty:write')
    if (!writeCall) {
      throw new Error('missing pty:write listener')
    }
    return writeCall[1] as (event: unknown, args: { id: string; data: string }) => void
  }

  function installDaemonTestProvider() {
    const spawn = vi.fn(async (options: { sessionId?: string }) => ({
      id: options.sessionId ?? 'daemon-pty'
    }))
    setLocalPtyProvider({
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
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
    return spawn
  }

  function installObservableDaemonTestProvider() {
    const spawn = vi.fn(async (options: { sessionId?: string }) => ({
      id: options.sessionId ?? 'daemon-pty'
    }))
    let dataHandler: ((payload: { id: string; data: string }) => void) | null = null
    let exitHandler: ((payload: { id: string; code: number }) => void) | null = null
    setLocalPtyProvider({
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
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
      onData: vi.fn((handler: (payload: { id: string; data: string }) => void) => {
        dataHandler = handler
        return () => {}
      }),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn((handler: (payload: { id: string; code: number }) => void) => {
        exitHandler = handler
        return () => {}
      }),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    return {
      spawn,
      emitData: (id: string, data: string) => dataHandler?.({ id, data }),
      emitExit: (id: string, code = 0) => exitHandler?.({ id, code })
    }
  }

  function getPtyAckDataListener(): (
    event: unknown,
    args: { id: string; charCount: number }
  ) => void {
    const ackCall = onMock.mock.calls.find((call: unknown[]) => call[0] === 'pty:ackData')
    if (!ackCall) {
      throw new Error('missing pty:ackData listener')
    }
    return ackCall[1] as (event: unknown, args: { id: string; charCount: number }) => void
  }

  function getPtySetActiveRendererPtyListener(): (
    event: unknown,
    args: { id: string; active: boolean }
  ) => void {
    const activeCall = onMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'pty:setActiveRendererPty'
    )
    if (!activeCall) {
      throw new Error('missing pty:setActiveRendererPty listener')
    }
    return activeCall[1] as (event: unknown, args: { id: string; active: boolean }) => void
  }

  /** Helper: trigger pty:spawn and return the env passed to node-pty. */
  async function spawnAndGetEnv(
    argsEnv?: Record<string, string>,
    processEnvOverrides?: Record<string, string | undefined>,
    getSelectedCodexHomePath?: () => string | null,
    getSettings?: () => {
      enableGitHubAttribution?: boolean
      agentStatusHooksEnabled?: boolean
      httpProxyUrl?: string
      httpProxyBypassRules?: string
    },
    // Why: PR #2662 finding 2 — the threading from IPC `args.command` through
    // buildPtyHostEnv to piTitlebarExtensionService.buildPtyEnv was untested
    // for the OMP case because this helper never forwarded a command. Accept
    // an optional `command` so callers can exercise OMP target resolution.
    command?: string
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
        ...(argsEnv ? { env: argsEnv } : {}),
        ...(command ? { command } : {})
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

  async function spawnAndGetCall(args?: {
    cwd?: string
    env?: Record<string, string>
    command?: string
  }): Promise<[string, string[], { cwd: string; env: Record<string, string> }]> {
    handlers.clear()
    registerPtyHandlers(mainWindow as never)
    await handlers.get('pty:spawn')!(null, {
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
      const env = await spawnAndGetEnv(undefined, undefined, () => TEST_CODEX_HOME)
      expect(env.CODEX_HOME).toBe(TEST_CODEX_HOME)
      expect(env.ORCA_CODEX_HOME).toBe(TEST_CODEX_HOME)
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

    it('does not treat inherited Orca OpenCode config as user config without a source dir', async () => {
      const env = await spawnAndGetEnv({
        OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay',
        ORCA_OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay'
      })

      expect(openCodeBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined)
      expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-config')
      expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-config')
      expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
    })

    it('restores user OpenCode config when agent status hooks are disabled in a nested Orca shell', async () => {
      const env = await spawnAndGetEnv(
        {
          OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay',
          ORCA_OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay',
          ORCA_OPENCODE_SOURCE_CONFIG_DIR: '/tmp/user-opencode-config'
        },
        undefined,
        undefined,
        () => ({ agentStatusHooksEnabled: false })
      )

      expect(openCodeBuildPtyEnvMock).not.toHaveBeenCalled()
      expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/user-opencode-config')
      expect(env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
    })

    it('strips inherited OpenCode overlay env when agent status hooks are disabled without a source dir', async () => {
      const env = await spawnAndGetEnv(
        {
          OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay',
          ORCA_OPENCODE_CONFIG_DIR: '/tmp/parent-orca-opencode-overlay'
        },
        undefined,
        undefined,
        () => ({ agentStatusHooksEnabled: false })
      )

      expect(openCodeBuildPtyEnvMock).not.toHaveBeenCalled()
      expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
    })

    posixOnlyIt(
      'reproduces issue #1534: GUI-launched Orca mirrors zshrc-only OpenCode config',
      async () => {
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
      }
    )

    it('installs Pi managed extensions without redirecting Orca terminal PTY homes', async () => {
      const env = await spawnAndGetEnv(undefined, { PI_CODING_AGENT_DIR: '/tmp/user-pi-agent' })
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), '/tmp/user-pi-agent', 'pi')
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'omp')
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/user-pi-agent')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/tmp/user-pi-agent')
      expect(env.ORCA_OMP_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(
        '/tmp/default-omp-agent/extensions/orca-agent-status.ts'
      )
    })

    it('threads command: "omp" through to piBuildPtyEnv and emits OMP status metadata', async () => {
      // Why: OMP launches must emit OMP-named Orca shadow vars (ORCA_OMP_*),
      // not Pi-named ones. The PI_CODING_AGENT_DIR binary var is unavoidable
      // (OMP's own binary reads it — see C:\tmp\pr-workspace\oh-my-pi
      // packages/utils/src/dirs.ts), but every other Orca-owned env name
      // stays kind-scoped so an OMP PTY never accumulates Pi shadow state.
      const env = await spawnAndGetEnv(
        undefined,
        { PI_CODING_AGENT_DIR: '/tmp/user-omp-agent' },
        undefined,
        undefined,
        'omp'
      )
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/user-omp-agent',
        'omp'
      )
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/user-omp-agent')
      expect(env.ORCA_OMP_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(
        '/tmp/user-omp-agent/extensions/orca-agent-status.ts'
      )
      expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBe('/tmp/user-omp-agent')
      // CRITICAL: a Pi-named shadow MUST NOT leak into an OMP PTY env.
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
    })

    it('mirrors the original Pi source dir when launched from an Orca overlay shell', async () => {
      const env = await spawnAndGetEnv({
        PI_CODING_AGENT_DIR: '/tmp/parent-orca-pi-overlay',
        ORCA_PI_SOURCE_AGENT_DIR: '/tmp/user-pi-agent'
      })
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), '/tmp/user-pi-agent', 'pi')
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/parent-orca-pi-overlay')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/tmp/user-pi-agent')
    })

    it('does not use an inherited Pi overlay source for an OMP launch', async () => {
      const env = await spawnAndGetEnv(
        {
          PI_CODING_AGENT_DIR: '/tmp/parent-orca-pi-overlay',
          ORCA_PI_CODING_AGENT_DIR: '/tmp/parent-orca-pi-overlay',
          ORCA_PI_SOURCE_AGENT_DIR: '/tmp/user-pi-agent'
        },
        undefined,
        undefined,
        undefined,
        'omp'
      )

      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'omp')
      expect(env.ORCA_OMP_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBe('/tmp/default-omp-agent')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
    })

    it('does not use an inherited OMP overlay source for an explicit Pi launch', async () => {
      const env = await spawnAndGetEnv(
        {
          PI_CODING_AGENT_DIR: '/tmp/parent-orca-omp-overlay',
          ORCA_OMP_CODING_AGENT_DIR: '/tmp/parent-orca-omp-overlay',
          ORCA_OMP_SOURCE_AGENT_DIR: '/tmp/user-omp-agent'
        },
        undefined,
        undefined,
        undefined,
        'pi'
      )

      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'pi')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/tmp/default-pi-agent')
      expect(env.ORCA_OMP_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_OMP_STATUS_EXTENSION).toBeUndefined()
    })

    it('restores user Pi config when agent status hooks are disabled in a nested Orca shell', async () => {
      const env = await spawnAndGetEnv(
        {
          PI_CODING_AGENT_DIR: '/tmp/parent-orca-pi-overlay',
          ORCA_PI_CODING_AGENT_DIR: '/tmp/parent-orca-pi-overlay',
          ORCA_PI_SOURCE_AGENT_DIR: '/tmp/user-pi-agent'
        },
        undefined,
        undefined,
        () => ({ agentStatusHooksEnabled: false })
      )

      expect(piBuildPtyEnvMock).not.toHaveBeenCalled()
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/user-pi-agent')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
    })

    posixOnlyIt(
      'uses Pi config exported only by shell startup files as the managed extension target',
      async () => {
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
          '/home/tester/.config/pi-agent',
          'pi'
        )
        expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/home/tester/.config/pi-agent')
      }
    )

    it('injects the agent hook receiver env into Orca terminal PTYs', async () => {
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

    it('strips stale inherited hook receiver env before injecting this runtime', async () => {
      const env = await spawnAndGetEnv({
        ORCA_AGENT_HOOK_PORT: '1111',
        ORCA_AGENT_HOOK_TOKEN: 'stale-token',
        ORCA_AGENT_HOOK_ENV: 'production',
        ORCA_AGENT_HOOK_VERSION: 'stale-version',
        ORCA_AGENT_HOOK_ENDPOINT: '/tmp/stale-endpoint.env',
        ORCA_CLAUDE_AGENT_STATUS_SETTINGS: '/tmp/orca/agent-hooks/claude-agent-status-settings.json'
      })

      expect(env.ORCA_AGENT_HOOK_PORT).toBe('5678')
      expect(env.ORCA_AGENT_HOOK_TOKEN).toBe('agent-token')
      expect(env.ORCA_AGENT_HOOK_ENV).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_VERSION).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
      expect(env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS).toBeUndefined()
    })

    it('does not leak inherited hook receiver env if the hook server is unavailable', async () => {
      buildAgentHookEnvMock.mockReturnValueOnce({})

      const env = await spawnAndGetEnv({
        ORCA_AGENT_HOOK_PORT: '1111',
        ORCA_AGENT_HOOK_TOKEN: 'stale-token',
        ORCA_AGENT_HOOK_ENV: 'production',
        ORCA_AGENT_HOOK_VERSION: 'stale-version',
        ORCA_AGENT_HOOK_ENDPOINT: '/tmp/stale-endpoint.env',
        ORCA_CLAUDE_AGENT_STATUS_SETTINGS: '/tmp/orca/agent-hooks/claude-agent-status-settings.json'
      })

      expect(env.ORCA_AGENT_HOOK_PORT).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_TOKEN).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_ENV).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_VERSION).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
      expect(env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS).toBeUndefined()
    })

    it('prepends local git/gh attribution shims when attribution is enabled', async () => {
      const env = await spawnAndGetEnv(undefined, undefined, undefined, () => ({
        enableGitHubAttribution: true
      }))

      expect(env.ORCA_ENABLE_GIT_ATTRIBUTION).toBe('1')
      expect(env.ORCA_GIT_COMMIT_TRAILER).toBe('Co-authored-by: Orca <help@stably.ai>')
      expect(env.ORCA_GH_PR_FOOTER).toBe('Made with [Orca](https://github.com/stablyai/orca) 🐋')
      expect(env.ORCA_GH_ISSUE_FOOTER).toBe('Made with [Orca](https://github.com/stablyai/orca) 🐋')
      expect(env.PATH).toContain(expectedAttributionShimDir)
    })

    it('skips git/gh attribution shims when attribution is disabled', async () => {
      const env = await spawnAndGetEnv(undefined, undefined, undefined, () => ({
        enableGitHubAttribution: false
      }))

      expect(env.ORCA_ENABLE_GIT_ATTRIBUTION).toBeUndefined()
      expect(env.ORCA_GIT_COMMIT_TRAILER).toBeUndefined()
      expect(env.ORCA_GH_PR_FOOTER).toBeUndefined()
      expect(env.ORCA_GH_ISSUE_FOOTER).toBeUndefined()
      expect(env.PATH ?? '').not.toContain(expectedAttributionShimDir)
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
      expect(env.PATH).toContain(expectedAttributionShimDir)
    })

    it('overrides ambient CODEX_HOME with the Orca-managed home for system default', async () => {
      const env = await spawnAndGetEnv(
        undefined,
        { CODEX_HOME: '/tmp/system-codex-home' },
        () => TEST_CODEX_HOME
      )
      expect(env.CODEX_HOME).toBe(TEST_CODEX_HOME)
      expect(env.ORCA_CODEX_HOME).toBe(TEST_CODEX_HOME)
    })

    it('injects explicit proxy settings into local PTY env', async () => {
      const env = await spawnAndGetEnv(undefined, undefined, undefined, () => ({
        httpProxyUrl: 'http://proxy.example:8080',
        httpProxyBypassRules: 'localhost,*.internal'
      }))

      expect(env.HTTP_PROXY).toBe('http://proxy.example:8080')
      expect(env.HTTPS_PROXY).toBe('http://proxy.example:8080')
      expect(env.ALL_PROXY).toBe('http://proxy.example:8080')
      expect(env.NO_PROXY).toBe('localhost,*.internal')
    })

    describe('daemon-active provider (parity with LocalPtyProvider)', () => {
      // Why: these tests guard the regression the daemon-parity refactor was
      // written to fix — under the daemon, LocalPtyProvider.buildSpawnEnv is
      // never invoked, so every host-local env injection must happen inside
      // the pty:spawn IPC handler instead. Before the refactor, only the
      // hook server env and attribution shims were injected on this path;
      // OpenCode plugin dir, Pi managed extension env, Codex home, and dev-mode CLI
      // overrides were silently missing for daemon users (the common case).

      function setupDaemonAdapter() {
        const daemonSpawn = vi.fn(
          async (options: {
            env: Record<string, string>
            sessionId?: string
            isNewSession?: boolean
          }) => ({
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

      type DaemonSpawnCall = {
        env: Record<string, string>
        envToDelete?: string[]
        isNewSession?: boolean
        shellOverride?: string
        terminalWindowsWslDistro?: string | null
        terminalWindowsPowerShellImplementation?: string
      }

      async function withWin32Platform<T>(fn: () => Promise<T>): Promise<T> {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: 'win32'
        })
        try {
          return await fn()
        } finally {
          if (platform) {
            Object.defineProperty(process, 'platform', platform)
          }
        }
      }

      function makeProjectRuntimeStore(args: {
        projectRuntimePreference: unknown
        settings?: Record<string, unknown>
      }) {
        const settings = {
          localWindowsRuntimeDefault: { kind: 'windows-host' },
          ...args.settings
        }
        return {
          getRepo: vi.fn((repoId: string) =>
            repoId === 'repo-1' ? { id: 'repo-1', path: 'C:\\repo' } : undefined
          ),
          getProjects: vi.fn(() => [
            {
              id: 'project-1',
              sourceRepoIds: ['repo-1'],
              localWindowsRuntimePreference: args.projectRuntimePreference
            }
          ]),
          getSettings: vi.fn(() => settings)
        }
      }

      async function daemonSpawnAndGetOptions(
        argsEnv?: Record<string, string>,
        getSelectedCodexHomePath?: () => string | null,
        getSettings?: () => {
          enableGitHubAttribution?: boolean
          httpProxyUrl?: string
          httpProxyBypassRules?: string
        },
        processEnvOverrides?: Record<string, string | undefined>,
        // Why: daemon spawn tests need to exercise both WSL launch metadata
        // from main and PR #2662 command threading for OMP target selection.
        spawnArgs?: {
          cwd?: string
          shellOverride?: string
          command?: string
          envToDelete?: string[]
        }
      ): Promise<DaemonSpawnCall> {
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
            ...spawnArgs,
            ...(argsEnv ? { env: argsEnv } : {})
          })
          return daemonSpawn.mock.calls.at(-1)![0] as DaemonSpawnCall
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

      async function daemonSpawnAndGetEnv(
        argsEnv?: Record<string, string>,
        getSelectedCodexHomePath?: () => string | null,
        getSettings?: () => {
          enableGitHubAttribution?: boolean
          httpProxyUrl?: string
          httpProxyBypassRules?: string
        },
        processEnvOverrides?: Record<string, string | undefined>,
        spawnArgs?: { cwd?: string; shellOverride?: string; command?: string }
      ): Promise<Record<string, string>> {
        return (
          await daemonSpawnAndGetOptions(
            argsEnv,
            getSelectedCodexHomePath,
            getSettings,
            processEnvOverrides,
            spawnArgs
          )
        ).env
      }

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
        // Why: OpenCode loads config from a single dir, so the user's path is
        // mirrored into a source-scoped overlay rather than passed through literally.
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
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), '/user/.pi/agent', 'pi')
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'omp')
        expect(env.PI_CODING_AGENT_DIR).toBe('/user/.pi/agent')
        expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/user/.pi/agent')
        expect(env.ORCA_OMP_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(expectedOmpStatusExtension)
      })

      it('threads command: "omp" through to piBuildPtyEnv on the daemon path with OMP status metadata', async () => {
        // Why: mirror of the local-spawn OMP threading assertion. The
        // daemon path's `command` forwarding could silently regress and
        // Pi-only tests would still pass.
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
          'omp'
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

      it('injects the selected Codex home on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({}, () => TEST_CODEX_HOME)
        expect(env.CODEX_HOME).toBe(TEST_CODEX_HOME)
        expect(env.ORCA_CODEX_HOME).toBe(TEST_CODEX_HOME)
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
            { cwd: '\\\\wsl.localhost\\Ubuntu\\home\\test\\repo' }
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
          onPtySpawned: vi.fn(),
          onPtyExit: vi.fn(),
          onPtyData: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never, undefined, (() => ({
          enableGitHubAttribution: true
        })) as never)
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

        await controller.spawn({
          cols: 80,
          rows: 24,
          worktreeId: 'wt-runtime',
          command: 'claude',
          env: {
            PATH: `/tmp/orca-agent-teams-bin${delimiter}/usr/bin`,
            ORCA_AGENT_TEAMS_TEAM_ID: 'team-test',
            TERM_PROGRAM: 'Orca',
            ORCA_ATTRIBUTION_SHIM_DIR: '/tmp/stale-attribution'
          },
          envToDelete: ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR']
        })

        const spawnOptions = daemonSpawn.mock.calls.at(-1)?.[0] as DaemonSpawnCall
        expect(spawnOptions.env.PATH.split(delimiter)[0]).toBe('/tmp/orca-agent-teams-bin')
        expect(spawnOptions.env.PATH).toContain(expectedAttributionShimDir)
        expect(spawnOptions.env.TERM_PROGRAM).toBeUndefined()
        expect(spawnOptions.env.ORCA_ATTRIBUTION_SHIM_DIR).toBeUndefined()
        expect(spawnOptions.envToDelete).toEqual(
          expect.arrayContaining(['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR'])
        )
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

      it('prepends attribution shims on the daemon path', async () => {
        const env = await daemonSpawnAndGetEnv({}, undefined, () => ({
          enableGitHubAttribution: true
        }))
        expect(env.ORCA_ENABLE_GIT_ATTRIBUTION).toBe('1')
        expect(env.PATH).toContain(expectedAttributionShimDir)
      })

      it('keeps the Agent Teams tmux shim ahead of host PATH shims on daemon pty:spawn', async () => {
        const spawnOptions = await daemonSpawnAndGetOptions(
          {
            PATH: `/tmp/orca-agent-teams-bin${delimiter}/usr/bin`,
            ORCA_AGENT_TEAMS_TEAM_ID: 'team-test',
            TERM_PROGRAM: 'Orca',
            ORCA_ATTRIBUTION_SHIM_DIR: '/tmp/stale-attribution'
          },
          undefined,
          () => ({ enableGitHubAttribution: true }),
          undefined,
          {
            command: 'claude',
            envToDelete: ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR']
          }
        )

        expect(spawnOptions.env.PATH.split(delimiter)[0]).toBe('/tmp/orca-agent-teams-bin')
        expect(spawnOptions.env.PATH).toContain(expectedAttributionShimDir)
        expect(spawnOptions.env.TERM_PROGRAM).toBeUndefined()
        expect(spawnOptions.env.ORCA_ATTRIBUTION_SHIM_DIR).toBeUndefined()
        expect(spawnOptions.envToDelete).toEqual(
          expect.arrayContaining(['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR'])
        )
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

      it('passes the minted sessionId through to provider.spawn and host env setup', async () => {
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
        expect(spawnOpts.isNewSession).toBe(true)
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(sessionId, undefined, 'pi')
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
        expect(daemonSpawn.mock.calls.at(-1)![0].isNewSession).toBeUndefined()
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith('user-session-42', undefined, 'pi')
      })

      it('prefixes a minted sessionId with the worktreeId when provided', async () => {
        // Why: daemon reconnect keys live-shell survival on the sessionId.
        // Prefixing with worktreeId lets the daemon scope sessions by worktree
        // while still minting a unique tail. The format contract is
        // `${worktreeId}@@${8-char-hex}` and must not regress.
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
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(sessionId, undefined, 'pi')
      })

      it('falls back to process.env.PI_CODING_AGENT_DIR when baseEnv lacks it on the daemon path', async () => {
        // Why: buildPtyHostEnv reads `baseEnv.X ?? process.env.X` so the
        // existing-agent-dir guard stays consistent whether Pi's env was
        // carried on the IPC wire or inherited by the daemon via fork. The
        // fallback must reach piTitlebarExtensionService.buildPtyEnv as the
        // second arg so Orca installs managed extensions in the user's root.
        const env = await daemonSpawnAndGetEnv({}, undefined, undefined, {
          PI_CODING_AGENT_DIR: '/ambient/pi/agent'
        })
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
          expect.any(String),
          '/ambient/pi/agent',
          'pi'
        )
        expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/ambient/pi/agent')
      })

      it('skips attribution shims on the daemon path when the setting is disabled', async () => {
        const env = await daemonSpawnAndGetEnv({ PATH: '/usr/bin' }, undefined, () => ({
          enableGitHubAttribution: false
        }))
        expect(env.ORCA_ENABLE_GIT_ATTRIBUTION).toBeUndefined()
        expect(env.PATH ?? '').not.toContain(expectedAttributionShimDir)
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
        // Why: effectiveSessionId reaches filesystem side-effects for provider
        // hook state and stale pre-migration Pi overlay cleanup. A crafted IPC
        // payload with traversal must be refused before those side-effects run.
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
        // Why: buildPtyHostEnv has filesystem side-effects (Pi/OMP managed
        // extension installation and legacy overlay cleanup). If provider.spawn
        // later fails, per-PTY state for the minted id should be cleared so it
        // isn't orphaned.
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
        // state (OpenCode hooks, legacy Pi overlay cleanup, agent-hook pane
        // caches) must not be clobbered on a retry/attach failure. Only minted
        // ids get swept.
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
          (() => ({
            httpProxyUrl: 'http://proxy.example:8080',
            httpProxyBypassRules: 'localhost'
          })) as never,
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
        expect(env.HTTP_PROXY).toBeUndefined()
        expect(env.HTTPS_PROXY).toBeUndefined()
        expect(env.NO_PROXY).toBeUndefined()
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

      it('marks a scoped SSH session expired using the raw relay lease id', async () => {
        const scopedPtyId = 'ssh:ssh-1@@remote-pty'
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
          ).rejects.toThrow('SSH_SESSION_EXPIRED: remote-pty')
        } finally {
          deletePtyOwnership(scopedPtyId)
        }

        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'remote-pty', 'expired')
        expect(openCodeClearPtyMock).toHaveBeenCalledWith(scopedPtyId)
        expect(piClearPtyMock).toHaveBeenCalledWith(scopedPtyId)
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

      it('passes keepHistory through runtime controller stopAndWait', async () => {
        vi.useFakeTimers()
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
        expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', -1)
      })

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
        await Promise.resolve()

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

        expect(controller.kill('ssh:ssh-1@@relay-pty')).toBe(true)

        expect(localShutdown).not.toHaveBeenCalled()
        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'relay-pty', 'terminated')
        expect(runtime.onPtyExit).toHaveBeenCalledWith('ssh:ssh-1@@relay-pty', -1)
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
        expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', -1)
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

  it('synthesizes runtime exit after ordinary daemon-backed pty kill', async () => {
    const shutdown = vi.fn(async () => undefined)
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
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:kill')!(null, { id: 'local-pty', keepHistory: true })

    expect(shutdown).toHaveBeenCalledWith('local-pty', {
      immediate: true,
      keepHistory: true
    })
    expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', -1)
  })

  it('waits for the desktop startup barrier before renderer local spawns resolve the provider', async () => {
    const barrier = makeDeferred()
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        awaitLocalPtyStartup: () => barrier.promise
      }
    )

    const pendingSpawn = handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    }) as Promise<{ id: string }>

    await Promise.resolve()
    expect(spawnMock).not.toHaveBeenCalled()

    const daemonSpawn = installDaemonTestProvider()
    barrier.resolve()
    const result = await pendingSpawn

    expect(daemonSpawn).toHaveBeenCalledTimes(1)
    expect(result.id).toBe(daemonSpawn.mock.calls[0]?.[0].sessionId)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rebinds local data and exit listeners after a late daemon provider install', async () => {
    vi.useFakeTimers()
    const barrier = makeDeferred()
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn(() => 13),
      createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-1'),
      registerPreAllocatedHandleForPty: vi.fn()
    }

    try {
      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          awaitLocalPtyStartup: () => barrier.promise
        }
      )

      const pendingSpawn = handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        sessionId: 'daemon-session'
      }) as Promise<{ id: string }>
      await Promise.resolve()

      const daemon = installObservableDaemonTestProvider()
      rebindLocalProviderListeners()
      barrier.resolve()
      const result = await pendingSpawn

      daemon.emitData(result.id, 'daemon output')
      vi.advanceTimersByTime(8)
      daemon.emitExit(result.id, 0)

      expect(daemon.spawn).toHaveBeenCalledTimes(1)
      expect(runtime.onPtyData).toHaveBeenCalledWith(result.id, 'daemon output', expect.any(Number))
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: result.id,
        data: 'daemon output',
        seq: 13,
        rawLength: 'daemon output'.length
      })
      expect(runtime.onPtyExit).toHaveBeenCalledWith(result.id, 0)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:exit', {
        id: result.id,
        code: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for the desktop startup barrier before runtime local spawns resolve the provider', async () => {
    const barrier = makeDeferred()
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        awaitLocalPtyStartup: () => barrier.promise
      }
    )
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      spawn: (args: { cols: number; rows: number; env?: Record<string, string> }) => Promise<{
        id: string
      }>
    }

    const pendingSpawn = controller.spawn({ cols: 80, rows: 24, env: {} })

    await Promise.resolve()
    expect(spawnMock).not.toHaveBeenCalled()

    const daemonSpawn = installDaemonTestProvider()
    barrier.resolve()
    const result = await pendingSpawn

    expect(daemonSpawn).toHaveBeenCalledTimes(1)
    expect(result.id).toBe(daemonSpawn.mock.calls[0]?.[0].sessionId)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not wait on the desktop startup barrier for SSH spawns', async () => {
    const barrier = makeDeferred()
    const awaitLocalPtyStartup = vi.fn(() => barrier.promise)
    const sshSpawn = vi.fn(async () => ({ id: 'remote-pty' }))
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
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { awaitLocalPtyStartup }
    )

    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        connectionId: 'ssh-1',
        env: {}
      })
    ).resolves.toEqual(expect.objectContaining({ id: 'remote-pty' }))

    expect(awaitLocalPtyStartup).not.toHaveBeenCalled()
    expect(sshSpawn).toHaveBeenCalledTimes(1)
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

  it('lists duplicate SSH relay session ids as distinct app sessions', async () => {
    registerPtyHandlers(mainWindow as never)
    const shutdownA = vi.fn(async () => undefined)
    const shutdownB = vi.fn(async () => undefined)
    registerSshPtyProvider('ssh-a', {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: shutdownA,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => [
        { id: 'ssh:ssh-a@@pty-1', cwd: '/repo-a', title: 'ssh-a' }
      ]),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    registerSshPtyProvider('ssh-b', {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: shutdownB,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => [
        { id: 'ssh:ssh-b@@pty-1', cwd: '/repo-b', title: 'ssh-b' }
      ]),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    const sessions = (await handlers.get('pty:listSessions')!(null, undefined)) as {
      id: string
      cwd: string
      title: string
    }[]

    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ssh:ssh-a@@pty-1', cwd: '/repo-a' }),
        expect.objectContaining({ id: 'ssh:ssh-b@@pty-1', cwd: '/repo-b' })
      ])
    )

    await handlers.get('pty:kill')!(null, { id: 'ssh:ssh-a@@pty-1' })
    await handlers.get('pty:kill')!(null, { id: 'ssh:ssh-b@@pty-1' })

    expect(shutdownA).toHaveBeenCalledWith('ssh:ssh-a@@pty-1', {
      immediate: true,
      keepHistory: false
    })
    expect(shutdownB).toHaveBeenCalledWith('ssh:ssh-b@@pty-1', {
      immediate: true,
      keepHistory: false
    })
  })

  it('kills app-scoped SSH PTY ids through the parsed provider when ownership is not rebuilt', async () => {
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
    const sshShutdown = vi.fn(async () => undefined)
    const store = { markSshRemotePtyLease: vi.fn() }
    registerSshPtyProvider('ssh-1', {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: sshShutdown,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      store as never
    )

    await handlers.get('pty:kill')!(null, { id: 'ssh:ssh-1@@relay-pty' })

    expect(sshShutdown).toHaveBeenCalledWith('ssh:ssh-1@@relay-pty', {
      immediate: true,
      keepHistory: false
    })
    expect(localShutdown).not.toHaveBeenCalled()
    expect(store.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'relay-pty', 'terminated')
  })

  it('tombstones app-scoped SSH PTY ids instead of falling back local when ownership and provider are absent', async () => {
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
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      store as never
    )

    await handlers.get('pty:kill')!(null, { id: 'ssh:ssh-1@@relay-pty' })

    expect(localShutdown).not.toHaveBeenCalled()
    expect(store.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'relay-pty', 'terminated')
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

  it('returns idle process inspection results for detached SSH PTYs without a provider', async () => {
    const provider = {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
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
    registerPtyHandlers(mainWindow as never)
    setPtyOwnership('remote-pty', 'ssh-1')
    unregisterSshPtyProvider('ssh-1')

    await expect(handlers.get('pty:hasChildProcesses')!(null, { id: 'remote-pty' })).resolves.toBe(
      false
    )
    await expect(
      handlers.get('pty:getForegroundProcess')!(null, { id: 'remote-pty' })
    ).resolves.toBeNull()
    expect(provider.hasChildProcesses).not.toHaveBeenCalled()
    expect(provider.getForegroundProcess).not.toHaveBeenCalled()
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
      getDriver: vi.fn(() => ({ kind: 'host' })),
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

  it('does not update cached PTY size when runtime controller resize fails', async () => {
    type RuntimeResizeController = {
      spawn(args: { cols: number; rows: number }): Promise<{ id: string }>
      resize(ptyId: string, cols: number, rows: number): boolean
      getSize(ptyId: string): { cols: number; rows: number } | null
    }
    let controller: RuntimeResizeController | null = null
    const proc = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(() => {
        throw new Error('resize failed')
      }),
      kill: vi.fn(),
      process: 'zsh',
      pid: 12345
    }
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      preAllocateHandleForPty: vi.fn(),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never, runtime as never)
    const resizeController = controller as unknown as RuntimeResizeController
    const spawned = await resizeController.spawn({ cols: 80, rows: 24 })

    expect(resizeController.resize(spawned.id, 120, 30)).toBe(false)
    expect(resizeController.getSize(spawned.id)).toEqual({ cols: 80, rows: 24 })
  })

  it('persists runtime-owned headless session bindings when explicitly requested', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        env?: Record<string, string>
        tabId?: string
        leafId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    const store = {
      persistPtyBinding: vi.fn()
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

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const spawnController = controller as unknown as RuntimeSpawnController
    const leafId = '11111111-1111-4111-8111-111111111111'
    await spawnController.spawn({
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-headless',
      leafId,
      env: { ORCA_PANE_KEY: makePaneKey('tab-headless', leafId) },
      persistHostSessionBinding: true
    })

    expect(store.persistPtyBinding).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'tab-headless',
      leafId,
      ptyId: expect.any(String)
    })
  })

  it('records SSH leases for runtime-owned headless session bindings', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        connectionId?: string
        tabId?: string
        leafId?: string
        sessionId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    const remoteSpawn = vi.fn(async () => ({ id: 'ssh:ssh-1@@relay-pty' }))
    registerSshPtyProvider('ssh-1', {
      spawn: remoteSpawn,
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
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
    } as never)
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(),
      removeSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const spawnController = controller as unknown as RuntimeSpawnController
    const leafId = '11111111-1111-4111-8111-111111111111'
    await spawnController.spawn({
      cols: 80,
      rows: 24,
      connectionId: 'ssh-1',
      worktreeId: 'wt-remote',
      tabId: 'tab-remote',
      leafId,
      sessionId: 'ssh:ssh-1@@relay-pty',
      persistHostSessionBinding: true
    })

    expect(store.upsertSshRemotePtyLease).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'ssh-1',
        ptyId: 'relay-pty',
        worktreeId: 'wt-remote',
        tabId: 'tab-remote',
        leafId,
        state: 'attached'
      })
    )
    expect(store.persistPtyBinding).toHaveBeenCalledWith({
      worktreeId: 'wt-remote',
      tabId: 'tab-remote',
      leafId,
      ptyId: 'ssh:ssh-1@@relay-pty'
    })
    expect(store.persistPtyBinding.mock.invocationCallOrder[0]!).toBeLessThan(
      store.upsertSshRemotePtyLease.mock.invocationCallOrder[0]!
    )
    unregisterSshPtyProvider('ssh-1')
  })

  it('rejects runtime-owned binding persistence without complete stable identity', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        tabId?: string
        leafId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    const store = {
      persistPtyBinding: vi.fn()
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

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const spawnController = controller as unknown as RuntimeSpawnController
    const validLeafId = '11111111-1111-4111-8111-111111111111'
    const baseArgs = {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-headless',
      leafId: validLeafId,
      persistHostSessionBinding: true
    }

    for (const args of [
      { ...baseArgs, worktreeId: undefined },
      { ...baseArgs, tabId: undefined },
      { ...baseArgs, leafId: undefined },
      { ...baseArgs, leafId: 'legacy-leaf' }
    ]) {
      await expect(spawnController.spawn(args)).rejects.toThrow(
        'Cannot persist runtime PTY binding without worktreeId, tabId, and leafId'
      )
    }
    expect(spawnMock).not.toHaveBeenCalled()
    expect(store.persistPtyBinding).not.toHaveBeenCalled()
  })

  it('refreshes SSH leases after successful runtime-owned reattach binding', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        connectionId?: string
        tabId?: string
        leafId?: string
        sessionId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string; isReattach?: boolean }>
    }
    registerSshPtyProvider('ssh-reattach-ok', {
      spawn: vi.fn(async () => ({ id: 'ssh:ssh-reattach-ok@@relay-pty', isReattach: true })),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
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
    } as never)
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(),
      removeSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    try {
      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        undefined,
        store as never
      )
      const spawnController = controller as unknown as RuntimeSpawnController
      const leafId = '11111111-1111-4111-8111-111111111111'
      await spawnController.spawn({
        cols: 80,
        rows: 24,
        connectionId: 'ssh-reattach-ok',
        worktreeId: 'wt-remote',
        tabId: 'tab-remote',
        leafId,
        sessionId: 'ssh:ssh-reattach-ok@@relay-pty',
        persistHostSessionBinding: true
      })

      expect(store.persistPtyBinding).toHaveBeenCalledWith({
        worktreeId: 'wt-remote',
        tabId: 'tab-remote',
        leafId,
        ptyId: 'ssh:ssh-reattach-ok@@relay-pty'
      })
      expect(store.upsertSshRemotePtyLease).toHaveBeenCalledWith(
        expect.objectContaining({
          targetId: 'ssh-reattach-ok',
          ptyId: 'relay-pty',
          state: 'attached',
          lastAttachedAt: expect.any(Number)
        })
      )
    } finally {
      unregisterSshPtyProvider('ssh-reattach-ok')
    }
  })

  it('strips runtime-owned SSH pane env when remote agent hooks are disabled', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        env?: Record<string, string>
        worktreeId?: string
        connectionId?: string
        tabId?: string
        leafId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    const savedRemoteHooks = process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '0'
    const remoteSpawn = vi.fn(async (_opts: { env?: Record<string, string> }) => ({
      id: 'ssh:ssh-runtime-env@@relay-pty'
    }))
    registerSshPtyProvider('ssh-runtime-env', {
      spawn: remoteSpawn,
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
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
    } as never)
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    try {
      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        undefined,
        store as never
      )
      const spawnController = controller as unknown as RuntimeSpawnController
      const leafId = '11111111-1111-4111-8111-111111111111'
      await spawnController.spawn({
        cols: 80,
        rows: 24,
        env: {
          FOO: 'bar',
          ORCA_PANE_KEY: makePaneKey('tab-remote', leafId),
          ORCA_TAB_ID: 'tab-remote',
          ORCA_WORKTREE_ID: 'wt-remote'
        },
        connectionId: 'ssh-runtime-env',
        worktreeId: 'wt-remote',
        tabId: 'tab-remote',
        leafId,
        persistHostSessionBinding: true
      })

      const env = remoteSpawn.mock.calls[0]?.[0].env
      expect(env).toMatchObject({ FOO: 'bar' })
      expect(env?.ORCA_PANE_KEY).toBeUndefined()
      expect(env?.ORCA_TAB_ID).toBeUndefined()
      expect(env?.ORCA_WORKTREE_ID).toBeUndefined()
      expect(store.upsertSshRemotePtyLease).toHaveBeenCalledWith(
        expect.objectContaining({
          targetId: 'ssh-runtime-env',
          ptyId: 'relay-pty',
          leafId,
          state: 'attached'
        })
      )
    } finally {
      if (savedRemoteHooks === undefined) {
        delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
      } else {
        process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = savedRemoteHooks
      }
      unregisterSshPtyProvider('ssh-runtime-env')
    }
  })

  it('does not leave SSH leases when runtime-owned binding persistence fails after reattach', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        connectionId?: string
        tabId?: string
        leafId?: string
        sessionId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    const remoteShutdown = vi.fn()
    const remoteWrite = vi.fn()
    registerSshPtyProvider('ssh-reattach-fail', {
      spawn: vi.fn(async () => ({ id: 'ssh:ssh-reattach-fail@@relay-pty', isReattach: true })),
      write: remoteWrite,
      resize: vi.fn(),
      shutdown: remoteShutdown,
      sendSignal: vi.fn(),
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
    } as never)
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(() => {
        throw new Error('disk full')
      }),
      removeSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const spawnController = controller as unknown as RuntimeSpawnController
    const leafId = '11111111-1111-4111-8111-111111111111'

    await expect(
      spawnController.spawn({
        cols: 80,
        rows: 24,
        connectionId: 'ssh-reattach-fail',
        worktreeId: 'wt-remote',
        tabId: 'tab-remote',
        leafId,
        sessionId: 'ssh:ssh-reattach-fail@@relay-pty',
        persistHostSessionBinding: true
      })
    ).rejects.toThrow(/ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED/)

    expect(store.upsertSshRemotePtyLease).not.toHaveBeenCalled()
    expect(store.removeSshRemotePtyLease).not.toHaveBeenCalled()
    expect(remoteShutdown).not.toHaveBeenCalled()
    getPtyWriteListener()(null, {
      id: 'ssh:ssh-reattach-fail@@relay-pty',
      data: 'echo should-not-route'
    })
    expect(remoteWrite).not.toHaveBeenCalled()
    unregisterSshPtyProvider('ssh-reattach-fail')
  })

  it('marks runtime-owned SSH reattach as expired and clears stale local ownership', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        connectionId?: string
        tabId?: string
        leafId?: string
        sessionId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    const appPtyId = 'ssh:ssh-expired-runtime@@relay-pty'
    const remoteWrite = vi.fn()
    registerSshPtyProvider('ssh-expired-runtime', {
      spawn: vi.fn(async () => {
        throw new Error(`${SSH_SESSION_EXPIRED_ERROR}: relay-pty`)
      }),
      write: remoteWrite,
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
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
    } as never)
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(),
      removeSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    try {
      setPtyOwnership(appPtyId, 'ssh-expired-runtime')
      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        undefined,
        store as never
      )
      const spawnController = controller as unknown as RuntimeSpawnController
      const leafId = '11111111-1111-4111-8111-111111111111'

      await expect(
        spawnController.spawn({
          cols: 80,
          rows: 24,
          connectionId: 'ssh-expired-runtime',
          worktreeId: 'wt-remote',
          tabId: 'tab-remote',
          leafId,
          sessionId: appPtyId,
          persistHostSessionBinding: true
        })
      ).rejects.toThrow(SSH_SESSION_EXPIRED_ERROR)

      expect(store.markSshRemotePtyLease).toHaveBeenCalledWith(
        'ssh-expired-runtime',
        'relay-pty',
        'expired'
      )
      expect(store.upsertSshRemotePtyLease).not.toHaveBeenCalled()
      expect(store.persistPtyBinding).not.toHaveBeenCalled()
      expect(openCodeClearPtyMock).toHaveBeenCalledWith(appPtyId)
      expect(piClearPtyMock).toHaveBeenCalledWith(appPtyId)
      getPtyWriteListener()(null, { id: appPtyId, data: 'echo nope' })
      expect(remoteWrite).not.toHaveBeenCalled()
    } finally {
      deletePtyOwnership(appPtyId)
      unregisterSshPtyProvider('ssh-expired-runtime')
    }
  })

  it('cleans up fresh runtime-owned SSH spawns when binding persistence fails', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        connectionId?: string
        tabId?: string
        leafId?: string
        sessionId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    const appPtyId = 'ssh:ssh-fresh-fail@@relay-pty'
    const remoteShutdown = vi.fn()
    registerSshPtyProvider('ssh-fresh-fail', {
      spawn: vi.fn(async () => ({ id: appPtyId })),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: remoteShutdown,
      sendSignal: vi.fn(),
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
    } as never)
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(() => {
        throw new Error('disk full')
      }),
      removeSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    try {
      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        undefined,
        store as never
      )
      const spawnController = controller as unknown as RuntimeSpawnController
      const leafId = '11111111-1111-4111-8111-111111111111'

      await expect(
        spawnController.spawn({
          cols: 80,
          rows: 24,
          connectionId: 'ssh-fresh-fail',
          worktreeId: 'wt-remote',
          tabId: 'tab-remote',
          leafId,
          sessionId: appPtyId,
          persistHostSessionBinding: true
        })
      ).rejects.toThrow(/ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED/)

      expect(remoteShutdown).toHaveBeenCalledWith(appPtyId, { immediate: true })
      expect(store.upsertSshRemotePtyLease).not.toHaveBeenCalled()
      expect(store.removeSshRemotePtyLease).not.toHaveBeenCalled()
      expect(openCodeClearPtyMock).toHaveBeenCalledWith(appPtyId)
      expect(piClearPtyMock).toHaveBeenCalledWith(appPtyId)
    } finally {
      unregisterSshPtyProvider('ssh-fresh-fail')
    }
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

  it('clears pending pane serializer declarations when their renderer is destroyed', async () => {
    registerPtyHandlers(mainWindow as never)
    const paneKey = makePaneKey('tab-crash', '22222222-2222-4222-8222-222222222222')
    const destroyedListeners: (() => void)[] = []
    const sender = {
      id: 42,
      once: vi.fn((event: string, listener: () => void) => {
        if (event === 'destroyed') {
          destroyedListeners.push(listener)
        }
      })
    }

    await handlers.get('pty:declarePendingPaneSerializer')!({ sender }, { paneKey })

    expect(hasPendingRendererSerializerForPaneKey(paneKey)).toBe(true)
    expect(destroyedListeners).toHaveLength(1)
    destroyedListeners[0]()
    expect(hasPendingRendererSerializerForPaneKey(paneKey)).toBe(false)
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

  it('forwards the trusted Orca terminal handle into managed WSL terminals', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    const runtime = {
      setPtyController: vi.fn(),
      preAllocateHandleForPty: vi.fn(() => 'term_wsl'),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    try {
      registerPtyHandlers(mainWindow as never, runtime as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const spawnCall = spawnMock.mock.calls.at(-1)!
    const env = spawnCall[2].env as Record<string, string>
    expect(spawnCall[0]).toBe('wsl.exe')
    expect(env.ORCA_TERMINAL_HANDLE).toBe('term_wsl')
    expect(env.WSLENV).toBe('ORCA_TERMINAL_HANDLE/u')
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

    it('passes chcp 65001 to cmd.exe for UTF-8 console output', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Windows\\system32\\cmd.exe',
        ['/K', 'chcp 65001 > nul'],
        expect.any(Object)
      )
    })

    it('sets Console encoding for powershell.exe', async () => {
      process.env.COMSPEC = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })

    it('sets Console encoding for pwsh.exe', async () => {
      process.env.COMSPEC = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })

    it('sets PYTHONUTF8=1 in the spawn environment on Windows', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      const env = spawnCall[2].env as Record<string, string>
      expect(env.PYTHONUTF8).toBe('1')
    })

    it('does not override an existing PYTHONUTF8 value', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      process.env.PYTHONUTF8 = '0'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      const env = spawnCall[2].env as Record<string, string>
      expect(env.PYTHONUTF8).toBe('0')
    })

    it('launches Git Bash from COMSPEC as an interactive login shell', async () => {
      process.env.COMSPEC = 'C:\\Program Files\\Git\\bin\\bash.exe'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        ['--login', '-i'],
        expect.objectContaining({
          env: expect.objectContaining({ CHERE_INVOKING: '1' })
        })
      )
    })

    it('uses terminalWindowsShell setting over COMSPEC when provided', async () => {
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
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'powershell.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })

    it('uses the host shell when resolved project runtime overrides a stale WSL shell default', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'wsl.exe',
            terminalWindowsWslDistro: 'Debian'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'windows-host',
            hostPlatform: 'win32',
            projectId: 'repo-1',
            source: 'project-override',
            cacheKey: 'repo-1:windows-host'
          }
        }
      })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Windows\\system32\\cmd.exe',
        ['/K', 'chcp 65001 > nul'],
        expect.any(Object)
      )
    })

    it('uses the selected project WSL distro when resolved runtime overrides the host shell default', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsWslDistro: 'Debian'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: 'C:\\Users\\test\\repo',
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'repo-1',
            distro: 'Ubuntu',
            source: 'project-override',
            cacheKey: 'repo-1:wsl:Ubuntu'
          }
        }
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[1]).toEqual(expect.arrayContaining(['-d', 'Ubuntu']))
    })

    it('blocks terminal spawn when project runtime requires repair', async () => {
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

      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          projectRuntime: {
            status: 'repair-required',
            repair: {
              projectId: 'repo-1',
              reason: 'wsl-distro-missing',
              requestedDistro: 'Ubuntu',
              fallbackRuntime: null,
              cacheKey: 'repo-1:repair:wsl-distro-missing:Ubuntu'
            }
          }
        })
      ).rejects.toThrow('Project runtime requires repair before terminal spawn')
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('spawns powershell.exe when PowerShell family keeps the inbox implementation', async () => {
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
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'powershell.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })

    it('spawns pwsh.exe when PowerShell 7 is selected and available', async () => {
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
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith('pwsh.exe', POWERSHELL_OSC133_ARGS, expect.any(Object))
    })

    it('falls back to powershell.exe when PowerShell 7 is selected but unavailable', async () => {
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
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'powershell.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })

    it('falls back to powershell.exe when shellOverride requests pwsh.exe but pwsh is unavailable', async () => {
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
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, shellOverride: 'pwsh.exe' })

      expect(spawnMock).toHaveBeenCalledWith(
        'powershell.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })

    it('ignores the PowerShell implementation setting for cmd.exe', async () => {
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
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'cmd.exe',
        ['/K', 'chcp 65001 > nul'],
        expect.any(Object)
      )
    })

    it('ignores the PowerShell implementation setting for wsl.exe', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\powershell.exe'
      isPwshAvailableMock.mockReturnValue(true)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        () => 'C:\\Users\\test\\AppData\\Roaming\\Orca\\codex-runtime-home\\home',
        () =>
          ({
            terminalWindowsShell: 'wsl.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as { env: Record<string, string> }
      expect(spawnMock).toHaveBeenCalledWith('wsl.exe', expect.any(Array), expect.any(Object))
      expect(spawnOptions.env.CODEX_HOME).toBeUndefined()
      expect(spawnOptions.env.ORCA_CODEX_HOME).toBeUndefined()
    })

    it('keeps shellOverride priority for one-off tabs', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      isPwshAvailableMock.mockReturnValue(false)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        () => 'C:\\Users\\test\\AppData\\Roaming\\Orca\\codex-runtime-home\\home',
        () =>
          ({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe'
      })

      const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as { env: Record<string, string> }
      expect(spawnMock).toHaveBeenCalledWith('wsl.exe', expect.any(Array), expect.any(Object))
      expect(spawnOptions.env.CODEX_HOME).toBeUndefined()
      expect(spawnOptions.env.ORCA_CODEX_HOME).toBeUndefined()
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

  it('spawns a plain POSIX login shell and queues startup commands for the live session', async () => {
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
      const [shell, args, options] = await spawnAndGetCall({
        cwd: '/tmp',
        command: 'printf "hello"'
      })
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

  it('uses the POSIX shell wrapper so OpenCode config survives shell startup files', async () => {
    const originalPlatform = process.platform
    const originalShell = process.env.SHELL

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    process.env.SHELL = '/bin/zsh'

    try {
      const [shell, args, options] = await spawnAndGetCall({ cwd: '/tmp' })
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

  it('uses the POSIX shell wrapper so Pi config survives shell startup files', async () => {
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
      const [shell, args, options] = await spawnAndGetCall({
        cwd: '/tmp',
        env: { PI_CODING_AGENT_DIR: '/tmp/user-pi-agent' }
      })
      expect(shell).toBe('/bin/zsh')
      expect(args).toEqual(['-l'])
      expect(options.env.OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(options.env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(options.env.PI_CODING_AGENT_DIR).toBe('/tmp/user-pi-agent')
      expect(options.env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
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
      await spawnAndGetCall({ cwd: '/tmp', command: 'echo hello' })

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

  posixOnlyIt(
    'does not write the startup command before the shell-ready marker arrives',
    async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
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
    }
  )

  posixOnlyIt(
    'uses the no-marker wrapper and writes quickly for Codex startup commands',
    async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp',
          command: 'codex'
        })

        const [, , options] = spawnMock.mock.calls[0]!
        expect(options.env.ORCA_SHELL_READY_MARKER).toBe('0')

        await Promise.resolve()
        vi.advanceTimersByTime(49)
        await Promise.resolve()
        expect(mockProc.proc.write).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        await Promise.resolve()
        vi.runAllTimers()
        expect(mockProc.proc.write).toHaveBeenCalledWith('codex\n')
      } finally {
        vi.useRealTimers()
      }
    }
  )

  posixOnlyIt('waits for shell-ready before writing delivery-hinted Codex startup', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        command: "codex 'linked issue context'",
        startupCommandDelivery: 'shell-ready'
      })

      const [, , options] = spawnMock.mock.calls[0]!
      expect(options.env.ORCA_SHELL_READY_MARKER).toBe('1')
      expect(mockProc.proc.write).not.toHaveBeenCalled()

      mockProc.emitData('last login: today\r\n')
      vi.advanceTimersByTime(1499)
      await Promise.resolve()
      expect(mockProc.proc.write).not.toHaveBeenCalled()

      mockProc.emitData('\x1b]777;orca-shell-ready\x07')
      await Promise.resolve()
      vi.advanceTimersByTime(49)
      await Promise.resolve()
      expect(mockProc.proc.write).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      await Promise.resolve()
      expect(mockProc.proc.write).toHaveBeenCalledWith("codex 'linked issue context'\n")
    } finally {
      vi.useRealTimers()
    }
  })

  posixOnlyIt('waits for shell-ready when Codex uses the native prefill flag', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        command: "codex --prefill 'linked issue context'"
      })

      const [, , options] = spawnMock.mock.calls[0]!
      expect(options.env.ORCA_SHELL_READY_MARKER).toBe('1')
      expect(mockProc.proc.write).not.toHaveBeenCalled()

      mockProc.emitData('\x1b]777;orca-shell-ready\x07')
      await Promise.resolve()
      vi.runAllTimers()
      await Promise.resolve()
      expect(mockProc.proc.write).toHaveBeenCalledWith("codex --prefill 'linked issue context'\n")
    } finally {
      vi.useRealTimers()
    }
  })

  posixOnlyIt('keeps the conservative max wait for non-agent startup commands', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        command: 'printf "hello"'
      })

      vi.advanceTimersByTime(1499)
      await Promise.resolve()
      expect(mockProc.proc.write).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      await Promise.resolve()
      vi.runAllTimers()
      expect(mockProc.proc.write).toHaveBeenCalledWith('printf "hello"\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('batches PTY output when it is not responding to recent input', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      mainWindow.webContents.send.mockClear()

      mockProc.emitData('background output')

      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(7)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'background output'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends small PTY redraws immediately after terminal input', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const writeListener = getPtyWriteListener()

      writeListener(null, {
        id: spawnResult.id,
        data: 'a'
      })
      mainWindow.webContents.send.mockClear()

      mockProc.emitData('\x1b[20;2Hredraw')

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: '\x1b[20;2Hredraw'
      })
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores PTY input for unknown sessions', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })
      const writeListener = getPtyWriteListener()

      writeListener(null, {
        id: 'missing-pty',
        data: 'a'
      })

      expect(mockProc.proc.write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('batches large PTY output even after recent terminal input', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const writeListener = getPtyWriteListener()

      writeListener(null, {
        id: spawnResult.id,
        data: 'a'
      })
      mainWindow.webContents.send.mockClear()

      const largeOutput = 'x'.repeat(1025)
      mockProc.emitData(largeOutput)

      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: largeOutput
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('batches repeated small PTY chunks after the interactive output budget is exhausted', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const writeListener = getPtyWriteListener()

      writeListener(null, {
        id: spawnResult.id,
        data: 'a'
      })
      mainWindow.webContents.send.mockClear()

      const smallChunk = 'x'.repeat(512)
      for (let index = 0; index < 65; index++) {
        mockProc.emitData(smallChunk)
      }

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(64)
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(65)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(65, 'pty:data', {
        id: spawnResult.id,
        data: smallChunk
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends larger ANSI redraws immediately after terminal input', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const writeListener = getPtyWriteListener()

      writeListener(null, {
        id: spawnResult.id,
        data: 'a'
      })
      mainWindow.webContents.send.mockClear()

      const redraw = `\x1b[2J\x1b[H${'codex composer redraw '.repeat(80)}`
      mockProc.emitData(redraw)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: redraw
      })
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('batches combined pending output that exceeds the interactive size limit', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const writeListener = getPtyWriteListener()

      const pendingOutput = 'x'.repeat(1020)
      mockProc.emitData(pendingOutput)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()

      writeListener(null, {
        id: spawnResult.id,
        data: 'a'
      })
      mockProc.emitData('redraw')

      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: `${pendingOutput}redraw`
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('drains large batched PTY output in bounded slices', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(secondProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const firstSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const secondSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      mainWindow.webContents.send.mockClear()

      const firstChunk = 'x'.repeat(16 * 1024)
      const firstRemainder = 'tail'
      secondProc.emitData('second-terminal-output')
      firstProc.emitData(`${firstChunk}${firstRemainder}`)

      vi.advanceTimersByTime(8)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(2)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(1, 'pty:data', {
        id: secondSpawn.id,
        data: 'second-terminal-output'
      })
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(2, 'pty:data', {
        id: firstSpawn.id,
        data: firstChunk
      })

      vi.advanceTimersByTime(1)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(3)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(3, 'pty:data', {
        id: firstSpawn.id,
        data: firstRemainder
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for renderer ACKs before sending more output for a saturated PTY', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(secondProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const firstSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const secondSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const ackData = getPtyAckDataListener()
      mainWindow.webContents.send.mockClear()

      firstProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      vi.advanceTimersByTime(1)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      expect(vi.getTimerCount()).toBe(0)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 88 * 1024,
        maxPendingCharsByPty: 88 * 1024,
        rendererInFlightPtyCount: 1,
        rendererInFlightChars: 512 * 1024,
        maxRendererInFlightCharsByPty: 512 * 1024,
        flushScheduled: false,
        peakPendingChars: 600 * 1024,
        peakMaxPendingCharsByPty: 600 * 1024,
        peakRendererInFlightChars: 512 * 1024,
        peakMaxRendererInFlightCharsByPty: 512 * 1024,
        ackGatedFlushSkipCount: 1
      })

      secondProc.emitData('second-terminal-output')
      vi.advanceTimersByTime(8)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(33)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(33, 'pty:data', {
        id: secondSpawn.id,
        data: 'second-terminal-output'
      })

      ackData(null, { id: firstSpawn.id, charCount: 16 * 1024 })
      vi.advanceTimersByTime(1)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(34)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(34, 'pty:data', {
        id: firstSpawn.id,
        data: 'x'.repeat(16 * 1024)
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 72 * 1024,
        rendererInFlightChars: 512 * 1024 + 'second-terminal-output'.length,
        peakPendingChars: 600 * 1024,
        peakRendererInFlightChars: 512 * 1024 + 'second-terminal-output'.length
      })

      resetPtyRendererDeliveryDebug()

      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 72 * 1024,
        rendererInFlightChars: 512 * 1024 + 'second-terminal-output'.length,
        peakPendingChars: 72 * 1024,
        peakRendererInFlightChars: 512 * 1024 + 'second-terminal-output'.length,
        ackGatedFlushSkipCount: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards only actually in-flight bytes to provider ACK backpressure', async () => {
    vi.useFakeTimers()
    const acknowledgeDataEvent = vi.fn()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      setLocalPtyProvider({
        spawn: vi.fn(async () => ({ id: 'remote-like-pty' })),
        write: vi.fn(),
        resize: vi.fn(),
        shutdown: vi.fn(),
        sendSignal: vi.fn(),
        getCwd: vi.fn(),
        getInitialCwd: vi.fn(),
        clearBuffer: vi.fn(),
        acknowledgeDataEvent,
        hasChildProcesses: vi.fn(),
        getForegroundProcess: vi.fn(),
        serialize: vi.fn(),
        revive: vi.fn(),
        onData: vi.fn((callback) => {
          mockProc.proc.onData((data: string) => callback({ id: 'remote-like-pty', data }))
          return () => {}
        }),
        onReplay: vi.fn(() => () => {}),
        onExit: vi.fn(() => () => {}),
        listProcesses: vi.fn(async () => []),
        attach: vi.fn(),
        getDefaultShell: vi.fn(),
        getProfiles: vi.fn()
      } as never)
      registerPtyHandlers(mainWindow as never)
      const ackData = getPtyAckDataListener()
      mainWindow.webContents.send.mockClear()

      mockProc.emitData('remote-output')
      vi.advanceTimersByTime(8)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: 'remote-like-pty',
        data: 'remote-output'
      })

      // Why: stale or duplicated renderer ACKs must not over-credit SSH/relay
      // flow control beyond the bytes main actually sent to the renderer.
      ackData(null, { id: 'remote-like-pty', charCount: 1024 })
      ackData(null, { id: 'remote-like-pty', charCount: 1024 })

      expect(acknowledgeDataEvent).toHaveBeenNthCalledWith(
        1,
        'remote-like-pty',
        'remote-output'.length
      )
      expect(acknowledgeDataEvent).toHaveBeenNthCalledWith(2, 'remote-like-pty', 0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reserves a bounded renderer lane for interactive output when bulk output is saturated', async () => {
    vi.useFakeTimers()
    const bulkProcs = Array.from({ length: 16 }, () => createMockProc())
    const interactiveProc = createMockProc()
    for (const proc of [...bulkProcs, interactiveProc]) {
      spawnMock.mockReturnValueOnce(proc.proc)
    }

    try {
      registerPtyHandlers(mainWindow as never)
      for (const _proc of bulkProcs) {
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })
      }
      const interactiveSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const writeListener = getPtyWriteListener()
      mainWindow.webContents.send.mockClear()

      for (const proc of bulkProcs) {
        proc.emitData('x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(512)
      expect(vi.getTimerCount()).toBe(0)

      writeListener(null, {
        id: interactiveSpawn.id,
        data: 'a'
      })
      interactiveProc.emitData('\x1b[20;2Hredraw')

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(513)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(513, 'pty:data', {
        id: interactiveSpawn.id,
        data: '\x1b[20;2Hredraw'
      })

      const reservePrefix = '\x1b[20;2H'
      const reserveChunk = `${reservePrefix}${'r'.repeat(16 * 1024 - reservePrefix.length)}`
      for (let index = 0; index < 16; index++) {
        writeListener(null, {
          id: interactiveSpawn.id,
          data: 'a'
        })
        interactiveProc.emitData(reserveChunk)
      }
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(529)

      writeListener(null, {
        id: interactiveSpawn.id,
        data: 'a'
      })
      interactiveProc.emitData(reserveChunk)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(529)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps total renderer in-flight output across many PTYs', async () => {
    vi.useFakeTimers()
    const procs = Array.from({ length: 17 }, () => createMockProc())
    for (const proc of procs) {
      spawnMock.mockReturnValueOnce(proc.proc)
    }

    try {
      registerPtyHandlers(mainWindow as never)
      const spawns: { id: string }[] = []
      for (const _proc of procs) {
        spawns.push(
          (await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            cwd: '/tmp'
          })) as { id: string }
        )
      }
      const ackData = getPtyAckDataListener()
      mainWindow.webContents.send.mockClear()

      for (const proc of procs) {
        proc.emitData('x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(512)
      ackData(null, { id: spawns[0].id, charCount: 16 * 1024 })
      vi.advanceTimersByTime(1)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(513)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prioritizes active PTY pending output during renderer backpressure', async () => {
    vi.useFakeTimers()
    const procs = Array.from({ length: 18 }, () => createMockProc())
    for (const proc of procs) {
      spawnMock.mockReturnValueOnce(proc.proc)
    }

    try {
      registerPtyHandlers(mainWindow as never)
      const spawns: { id: string }[] = []
      for (const _proc of procs) {
        spawns.push(
          (await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            cwd: '/tmp'
          })) as { id: string }
        )
      }
      const ackData = getPtyAckDataListener()
      const setActiveRendererPty = getPtySetActiveRendererPtyListener()
      mainWindow.webContents.send.mockClear()

      for (let index = 0; index < procs.length - 1; index++) {
        procs[index]!.emitData('x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(512)

      const activeIndex = procs.length - 1
      procs[activeIndex]!.emitData('active-output')
      setActiveRendererPty(null, { id: spawns[activeIndex]!.id, active: true })
      vi.advanceTimersByTime(8)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(513)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(513, 'pty:data', {
        id: spawns[activeIndex]!.id,
        data: 'active-output'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        activeRendererPtyCount: 1,
        pendingPtyCount: procs.length - 1,
        rendererInFlightChars: 8 * 1024 * 1024 + 'active-output'.length
      })
      ackData(null, { id: spawns[0]!.id, charCount: 16 * 1024 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets active PTY output exceed its old background in-flight cap', async () => {
    vi.useFakeTimers()
    const activeProc = createMockProc()
    spawnMock.mockReturnValue(activeProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const activeSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const setActiveRendererPty = getPtySetActiveRendererPtyListener()
      mainWindow.webContents.send.mockClear()

      activeProc.emitData('x'.repeat(768 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 256 * 1024,
        rendererInFlightChars: 512 * 1024,
        maxRendererInFlightCharsByPty: 512 * 1024
      })

      setActiveRendererPty(null, { id: activeSpawn.id, active: true })
      vi.advanceTimersByTime(1)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(33)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(33, 'pty:data', {
        id: activeSpawn.id,
        data: 'x'.repeat(16 * 1024)
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingChars: 240 * 1024,
        rendererInFlightChars: 528 * 1024,
        maxRendererInFlightCharsByPty: 528 * 1024
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('batches stale PTY output after the interactive window expires', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const writeListener = getPtyWriteListener()

      writeListener(null, {
        id: spawnResult.id,
        data: 'a'
      })
      vi.advanceTimersByTime(101)
      mainWindow.webContents.send.mockClear()

      mockProc.emitData('stale redraw')

      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'stale redraw'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  posixOnlyIt('falls back to a system shell when SHELL points to a missing binary', async () => {
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

  posixOnlyIt('falls back when SHELL points to a non-executable binary', async () => {
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

  it('acknowledges pty writes only for owned PTYs', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }

    expect(handlers.get('pty:writeAccepted')!(null, { id: result.id, data: '\x03' })).toBe(true)
    expect(mockProc.proc.write).toHaveBeenCalledWith('\x03')
    expect(
      handlers.get('pty:writeAccepted')!(null, {
        id: 'missing-pty-for-write-ack',
        data: '\x03'
      })
    ).toBe(false)
    expect(mockProc.proc.write).toHaveBeenCalledTimes(1)
  })

  it('seeds headless terminal state with cold-restore cwd metadata', async () => {
    const oscLinks = [{ row: 0, startCol: 0, endCol: 8, uri: 'https://example.com/restored' }]
    const coldRestore = {
      scrollback: 'restored history\r\n',
      cwd: '/projects/restored',
      oscLinks
    }
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: 'pty-cold-restore', coldRestore })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const runtime = {
      setPtyController: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'handle-cold-restore'),
      registerPreAllocatedHandleForPty: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    expect(runtime.seedHeadlessTerminal).toHaveBeenCalledWith(
      'pty-cold-restore',
      'restored history\r\n',
      undefined,
      { cwd: '/projects/restored', oscLinks }
    )
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

  posixOnlyIt('prefers args.env.SHELL and normalizes the child env after fallback', async () => {
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

  it('removes the previous orphan-cleanup listener from its original webContents', () => {
    const firstWindow = {
      isDestroyed: () => false,
      webContents: {
        on: vi.fn(),
        send: vi.fn(),
        removeListener: vi.fn()
      }
    }
    const secondWindow = {
      isDestroyed: () => false,
      webContents: {
        on: vi.fn(),
        send: vi.fn(),
        removeListener: vi.fn()
      }
    }

    registerPtyHandlers(firstWindow as never)
    const didFinishLoad = firstWindow.webContents.on.mock.calls.find(
      ([eventName]) => eventName === 'did-finish-load'
    )?.[1] as (() => void) | undefined
    expect(didFinishLoad).toBeTypeOf('function')

    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    registerPtyHandlers(secondWindow as never)

    expect(firstWindow.webContents.removeListener).toHaveBeenCalledWith(
      'did-finish-load',
      didFinishLoad
    )
    expect(
      secondWindow.webContents.on.mock.calls.some(([eventName]) => eventName === 'did-finish-load')
    ).toBe(false)
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

  describe('main buffer snapshot dispatch', () => {
    it('returns a sequenced main-owned terminal snapshot with clamped scrollback', async () => {
      const runtime = {
        setPtyController: vi.fn(),
        serializeMainTerminalBuffer: vi.fn().mockResolvedValue({
          data: 'snapshot\r\n',
          cols: 120,
          rows: 40,
          cwd: '/projects/restored',
          seq: 42,
          source: 'headless'
        })
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)

      const result = await handlers.get('pty:getMainBufferSnapshot')!(null, {
        id: 'pty-1',
        opts: { scrollbackRows: 999_999 }
      })

      expect(runtime.serializeMainTerminalBuffer).toHaveBeenCalledWith('pty-1', {
        scrollbackRows: 50_000
      })
      expect(result).toEqual({
        data: 'snapshot\r\n',
        cols: 120,
        rows: 40,
        cwd: '/projects/restored',
        seq: 42,
        source: 'headless'
      })
    })
  })
})
