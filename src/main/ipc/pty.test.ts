/* eslint-disable max-lines -- Why: PTY spawn env behavior is easiest to verify in
one focused file because the registration helper is stateful and each spawn-path
assertion reuses the same mocked IPC and node-pty harness. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userInfo } from 'node:os'
import { delimiter, join, posix } from 'node:path'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES
} from '../../shared/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../shared/clipboard-text'
import { redactPtyIdForDiagnostics } from '../../shared/pty-delivery-diagnostics'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'

const isWindowsHost = process.platform === 'win32'
const posixOnlyIt = isWindowsHost ? it.skip : it
const expectedOmpStatusExtension = posix.join(
  '/tmp/default-omp-agent',
  'extensions',
  'orca-agent-status.ts'
)
function expectedAttributionShimDir(): string {
  return join(
    '/tmp/orca-user-data',
    'orca-terminal-attribution',
    process.platform === 'win32' ? 'win32' : 'posix'
  )
}

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
  mimoCodeBuildPtyEnvMock,
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
  mimoCodeBuildPtyEnvMock: vi.fn(),
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
    getPath: getPathMock,
    getVersion: () => '0.0.0-test'
  },
  powerMonitor: {
    on: vi.fn()
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

vi.mock('../mimo/hook-service', () => ({
  mimoCodeHookService: {
    buildPtyEnv: mimoCodeBuildPtyEnvMock
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

// Why: the real ensure writes to disk from process.resourcesPath, which does
// not exist under vitest; env assembly only needs the returned dir path.
vi.mock('../cli/linux-terminal-orca-cli-shim', () => ({
  ensureLinuxTerminalOrcaCliShimDir: (options: { userDataPath: string }) =>
    join(options.userDataPath, 'linux-orca-cli-shim')
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
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
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
  unregisterSshPtyProvider,
  getLocalPtyProvider
} from './pty'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  isHiddenRendererPty
} from './pty-hidden-delivery-gate'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { hasLiveClaudePtys, markClaudePtySpawned } from '../claude-accounts/live-pty-gate'
import * as livePtyGate from '../claude-accounts/live-pty-gate'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from '../powershell-osc133-bootstrap'
import {
  SSH_PTY_IDENTITY_MISMATCH_ERROR,
  SSH_SESSION_EXPIRED_ERROR
} from '../providers/ssh-pty-provider'
import { _resetWslCachesForTests, _setWslCachesForTests } from '../wsl'

const POWERSHELL_OSC133_ARGS = [
  '-NoLogo',
  '-NoExit',
  '-EncodedCommand',
  encodePowerShellCommand(getPowerShellOsc133Bootstrap())
]
// Why: on Windows the spawn path resolves a bare PowerShell family name to a
// real absolute executable before handing it to ConPTY (PR #6537 / issue
// #5161) — a bare/alias `pwsh.exe` makes CreateProcessW fail with error code 5.
// These match the deterministic install roots pinned in the win32 beforeEach.
const RESOLVED_WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const RESOLVED_PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
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
    isFocused: () => true,
    isVisible: () => true,
    isMinimized: () => false,
    webContents: {
      on: vi.fn(),
      send: vi.fn(),
      removeListener: vi.fn(),
      // Why: the did-start-loading reset handler filters to main-frame loads via
      // isLoadingMainFrame; default true so lifecycle-reset tests still reset. A
      // subframe-load case overrides it to false.
      isLoadingMainFrame: vi.fn(() => true)
    }
  }
  const mainWindowIpcEvent = { sender: mainWindow.webContents }
  const foreignWindowIpcEvent = {
    sender: { on: vi.fn(), send: vi.fn(), removeListener: vi.fn() }
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
  const savedProcessPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const savedDisableMacosLoginShell = process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
  const savedOrcaUserDataPath = process.env.ORCA_USER_DATA_PATH

  beforeEach(() => {
    // Why: most PTY spawn tests assert POSIX shell behavior; Windows-specific
    // cases opt into win32 explicitly below.
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    // Why: with platform forced to darwin, the TCC login(1) wrapper would
    // rewrite every spawn argv these tests assert. Its own integration test
    // below re-enables it.
    process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = '1'
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
    mimoCodeBuildPtyEnvMock.mockReset()
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
    mainWindow.webContents.removeListener.mockReset()
    // Why: hidden-delivery gate state is module-level by design (PTY-keyed,
    // not window-keyed); tests must not leak hidden bits across cases.
    _resetHiddenRendererPtyDeliveryGateForTest()

    // Why: mirror real Electron — ipcMain.handle throws on a duplicate channel
    // unless removeHandler cleared it first. This catches a re-registration
    // (macOS re-activate / new window) that forgets to remove a handle channel.
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      handlers.set(channel, handler)
    })
    removeHandlerMock.mockImplementation((channel: string) => {
      handlers.delete(channel)
    })
    // Why: production holds PTY sends until the renderer's pty:data dispatcher
    // registers and sends pty:rendererDispatcherReady (the §1b boot-window gate).
    // These tests model a live page whose dispatcher is already listening, so
    // fire the handshake as soon as it registers. Lifecycle-reset tests re-close
    // the gate via did-start-loading and re-open it with an explicit handshake.
    onMock.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === 'pty:rendererDispatcherReady') {
        listener(mainWindowIpcEvent)
        // Drain the empty flush the handshake schedules so it can't fire later
        // (once real output is pending) and perturb send-timing assertions.
        if (vi.isFakeTimers()) {
          vi.advanceTimersByTime(0)
        }
      }
    })
    getPathMock.mockReturnValue('/tmp/orca-user-data')
    // Why: shell-ready wrapper roots resolve from ORCA_USER_DATA_PATH (main
    // canonicalizes it to app.getPath('userData') at startup before any spawn);
    // mirror that here so ZDOTDIR/wrapper assertions match the mocked userData.
    process.env.ORCA_USER_DATA_PATH = '/tmp/orca-user-data'
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
    mimoCodeBuildPtyEnvMock.mockImplementation((_ptyId: string, existingHome?: string) => ({
      MIMOCODE_HOME: existingHome ? '/tmp/orca-mimocode-overlay' : '/tmp/orca-mimocode-shared'
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
    // Why: sshProviders is module-level state; any id left registered leaks
    // into later tests (pty:listSessions sweeps every registered provider).
    for (const leakedConnectionId of [
      'ssh-1',
      'ssh-a',
      'ssh-b',
      'ssh-expired-runtime',
      'ssh-fresh-fail',
      'ssh-reattach-1',
      'ssh-reattach-fail',
      'ssh-reattach-ok',
      'ssh-runtime-env'
    ]) {
      unregisterSshPtyProvider(leakedConnectionId)
    }
    setLocalPtyProvider(new LocalPtyProvider())
    if (savedProcessPlatform) {
      Object.defineProperty(process, 'platform', savedProcessPlatform)
    }
    if (savedDisableMacosLoginShell !== undefined) {
      process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = savedDisableMacosLoginShell
    } else {
      delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    }
    if (savedOrcaUserDataPath !== undefined) {
      process.env.ORCA_USER_DATA_PATH = savedOrcaUserDataPath
    } else {
      delete process.env.ORCA_USER_DATA_PATH
    }
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
      confirmForegroundProcess: vi.fn(),
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
    const write = vi.fn()
    const pauseProducer = vi.fn()
    const resumeProducer = vi.fn()
    let dataHandler: ((payload: { id: string; data: string }) => void) | null = null
    let exitHandler: ((payload: { id: string; code: number }) => void) | null = null
    let backgroundStreamHandler:
      | ((payload: { id: string; kind: 'dataGap'; droppedChars: number }) => void)
      | null = null
    const getBufferSnapshot = vi.fn()
    setLocalPtyProvider({
      spawn,
      write,
      resize: vi.fn(),
      pauseProducer,
      resumeProducer,
      kill: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      confirmForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn((handler: (payload: { id: string; data: string }) => void) => {
        dataHandler = handler
        return () => {}
      }),
      onReplay: vi.fn(() => () => {}),
      onBackgroundStreamEvent: vi.fn(
        (handler: (payload: { id: string; kind: 'dataGap'; droppedChars: number }) => void) => {
          backgroundStreamHandler = handler
          return () => {}
        }
      ),
      getBufferSnapshot,
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
      write,
      pauseProducer,
      resumeProducer,
      getBufferSnapshot,
      emitData: (id: string, data: string) => dataHandler?.({ id, data }),
      emitExit: (id: string, code = 0) => exitHandler?.({ id, code }),
      emitDataGap: (id: string, droppedChars: number) =>
        backgroundStreamHandler?.({ id, kind: 'dataGap', droppedChars })
    }
  }

  function getPtyAckDataListener(): (
    event: unknown,
    args: { id: string; charCount?: number; processedChars?: number }
  ) => void {
    const ackCall = onMock.mock.calls.find((call: unknown[]) => call[0] === 'pty:ackData')
    if (!ackCall) {
      throw new Error('missing pty:ackData listener')
    }
    return ackCall[1] as (
      event: unknown,
      args: { id: string; charCount?: number; processedChars?: number }
    ) => void
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

  function getPtySetRendererPtyVisibleListener(): (
    event: unknown,
    args: { id: string; visible: boolean }
  ) => void {
    const visibleCall = onMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'pty:setRendererPtyVisible'
    )
    if (!visibleCall) {
      throw new Error('missing pty:setRendererPtyVisible listener')
    }
    return visibleCall[1] as (event: unknown, args: { id: string; visible: boolean }) => void
  }

  function getPtyRendererDispatcherReadyListener(): () => void {
    const readyCall = onMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'pty:rendererDispatcherReady'
    )
    if (!readyCall) {
      throw new Error('missing pty:rendererDispatcherReady listener')
    }
    const listener = readyCall[1] as (event: unknown) => void
    // Why: the production handler sender-guards its destructive reconcile, so
    // tests must present as the main window.
    return () => listener(mainWindowIpcEvent)
  }

  function getMainWindowWebContentsListener(eventName: string): (...args: unknown[]) => void {
    const listenerCall = mainWindow.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === eventName
    )
    if (!listenerCall) {
      throw new Error(`missing ${eventName} listener`)
    }
    return listenerCall[1] as (...args: unknown[]) => void
  }

  function getPtyResizeListener(): (
    event: unknown,
    args: { id: string; cols: number; rows: number }
  ) => void {
    const resizeCall = onMock.mock.calls.find((call: unknown[]) => call[0] === 'pty:resize')
    if (!resizeCall) {
      throw new Error('missing pty:resize listener')
    }
    return resizeCall[1] as (
      event: unknown,
      args: { id: string; cols: number; rows: number }
    ) => void
  }

  function getPtySetHiddenRendererPtyListener(): (
    event: unknown,
    args: { id: string; hidden: boolean }
  ) => void {
    const hiddenCall = onMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'pty:setHiddenRendererPty'
    )
    if (!hiddenCall) {
      throw new Error('missing pty:setHiddenRendererPty listener')
    }
    return hiddenCall[1] as (event: unknown, args: { id: string; hidden: boolean }) => void
  }

  function getPtySetDeliveryInterestListener(): (
    event: unknown,
    args: { id: string; interested: boolean }
  ) => void {
    const interestCall = onMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'pty:setPtyDeliveryInterest'
    )
    if (!interestCall) {
      throw new Error('missing pty:setPtyDeliveryInterest listener')
    }
    return interestCall[1] as (event: unknown, args: { id: string; interested: boolean }) => void
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

    it('injects MiMo overlay env only when launch command is mimo', async () => {
      const env = await spawnAndGetEnv(undefined, undefined, undefined, undefined, 'mimo')

      expect(mimoCodeBuildPtyEnvMock).toHaveBeenCalledTimes(1)
      expect(env.MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
      expect(env.ORCA_MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
      expect(env.ORCA_MIMOCODE_SOURCE_HOME).toBeUndefined()
    })

    it.each(['/usr/local/bin/mimo --prompt hi', '"C:\\Program Files\\MiMo\\mimo.cmd" --prompt hi'])(
      'injects MiMo overlay env for path-qualified launch command %s',
      async (launchCommand) => {
        const env = await spawnAndGetEnv(undefined, undefined, undefined, undefined, launchCommand)

        expect(mimoCodeBuildPtyEnvMock).toHaveBeenCalledTimes(1)
        expect(env.MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
        expect(env.ORCA_MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
      }
    )

    it('uses sequenced startup env as the MiMo launch hint when command is a wrapper', async () => {
      const env = await spawnAndGetEnv(
        { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'mimo --prompt hi' },
        undefined,
        undefined,
        undefined,
        'bash -lc wait-wrapper'
      )

      expect(mimoCodeBuildPtyEnvMock).toHaveBeenCalledTimes(1)
      expect(env.MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
      expect(env.ORCA_MIMOCODE_HOME).toBe('/tmp/orca-mimocode-shared')
    })

    it('does not inject MiMo overlay for non-mimo launches', async () => {
      await spawnAndGetEnv()

      expect(mimoCodeBuildPtyEnvMock).not.toHaveBeenCalled()
    })

    it('restores user MiMo home when agent status hooks are disabled in a nested Orca shell', async () => {
      const env = await spawnAndGetEnv(
        {
          MIMOCODE_HOME: '/tmp/parent-orca-mimocode-overlay',
          ORCA_MIMOCODE_HOME: '/tmp/parent-orca-mimocode-overlay',
          ORCA_MIMOCODE_SOURCE_HOME: '/tmp/user-mimocode-home'
        },
        undefined,
        undefined,
        () => ({ agentStatusHooksEnabled: false }),
        'mimo'
      )

      expect(mimoCodeBuildPtyEnvMock).not.toHaveBeenCalled()
      expect(env.MIMOCODE_HOME).toBe('/tmp/user-mimocode-home')
      expect(env.ORCA_MIMOCODE_HOME).toBeUndefined()
      expect(env.ORCA_MIMOCODE_SOURCE_HOME).toBeUndefined()
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

    it('uses sequenced startup env as the OMP launch hint when command is a wrapper', async () => {
      const env = await spawnAndGetEnv(
        {
          PI_CODING_AGENT_DIR: '/tmp/user-omp-agent',
          [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'omp --resume'
        },
        undefined,
        undefined,
        undefined,
        'powershell wait-wrapper'
      )

      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/user-omp-agent',
        'omp'
      )
      expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(
        '/tmp/user-omp-agent/extensions/orca-agent-status.ts'
      )
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
      expect(env.PATH).toContain(expectedAttributionShimDir())
    })

    it('skips git/gh attribution shims when attribution is disabled', async () => {
      const env = await spawnAndGetEnv(undefined, undefined, undefined, () => ({
        enableGitHubAttribution: false
      }))

      expect(env.ORCA_ENABLE_GIT_ATTRIBUTION).toBeUndefined()
      expect(env.ORCA_GIT_COMMIT_TRAILER).toBeUndefined()
      expect(env.ORCA_GH_PR_FOOTER).toBeUndefined()
      expect(env.ORCA_GH_ISSUE_FOOTER).toBeUndefined()
      expect(env.PATH ?? '').not.toContain(expectedAttributionShimDir())
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
      expect(env.PATH).toContain(expectedAttributionShimDir())
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
          worktreeId?: string
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
          'omp'
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

      it('prepends the bare-orca CLI shim dir to PATH for packaged Linux spawns', async () => {
        const originalPlatform = process.platform
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: 'linux'
        })
        try {
          // Why: overriding process.platform does not change the already-loaded
          // node:path dialect; keep this synthetic PATH internally consistent.
          const env = await daemonSpawnAndGetEnv({
            PATH: ['/usr/local/bin', '/usr/bin'].join(delimiter)
          })
          const entries = env.PATH.split(delimiter)
          const shimDir = join('/tmp/orca-user-data', 'linux-orca-cli-shim')
          // Why: bare `orca` must resolve to the Orca CLI before /usr/bin/orca
          // (the GNOME screen reader) inside Orca-managed terminals (#7904).
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

        // Why: runtime-created spawns (e.g. the mobile-create materialize path)
        // must thread the same {tabId, leafId} so the catch-path rescue can find
        // and keep their live PTY (#7587).
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
        expect(spawnOptions.env.PATH).toContain(expectedAttributionShimDir())
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
        expect(env.PATH).toContain(expectedAttributionShimDir())
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
        expect(spawnOptions.env.PATH).toContain(expectedAttributionShimDir())
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
        expect(env.PATH ?? '').not.toContain(expectedAttributionShimDir())
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
        const sshSpawn = vi.fn(
          async (_opts: { env: Record<string, string>; paneKey?: string; tabId?: string }) => ({
            id: 'ssh-pty'
          })
        )
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
        const spawnOptions = sshSpawn.mock.calls.at(-1)![0]
        const env = spawnOptions.env
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
        expect(env.MIMOCODE_HOME).toBeUndefined()
        expect(env.ORCA_MIMOCODE_HOME).toBeUndefined()
        expect(env.ORCA_MIMOCODE_SOURCE_HOME).toBeUndefined()
        expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
        expect(env.CODEX_HOME).toBeUndefined()
        expect(env.HTTP_PROXY).toBeUndefined()
        expect(env.HTTPS_PROXY).toBeUndefined()
        expect(env.NO_PROXY).toBeUndefined()
        expect(env.FOO).toBe('bar')
        expect(spawnOptions.paneKey).toBe(makePaneKey('tab-1', leafId))
        expect(spawnOptions.tabId).toBe('tab-1')
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
        const legacySpawnOptions = sshSpawn.mock.calls.at(-1)?.[0]
        expect(legacySpawnOptions?.env.ORCA_PANE_KEY).toBeUndefined()
        expect(legacySpawnOptions?.paneKey).toBeUndefined()
        expect(legacySpawnOptions?.tabId).toBe('tab-1')
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

      it('does not clear a scoped SSH session when remote reattach rejects an identity mismatch', async () => {
        const scopedPtyId = 'ssh:ssh-1@@remote-pty'
        const remoteWrite = vi.fn()
        const sshSpawn = vi.fn(async () => {
          throw new Error(
            `${SSH_SESSION_EXPIRED_ERROR}: remote-pty ${SSH_PTY_IDENTITY_MISMATCH_ERROR}`
          )
        })
        const store = {
          markSshRemotePtyLease: vi.fn()
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
        // Why: kill's shutdown now runs through the exit-detection wrapper,
        // which adds async hops; a single microtask flush is no longer enough.
        await new Promise((resolve) => setImmediate(resolve))

        expect(shutdown).toHaveBeenCalledWith('remote-pty', { immediate: false })
        expect(store.markSshRemotePtyLease).toHaveBeenCalledWith(
          'ssh-1',
          'remote-pty',
          'terminated'
        )
        expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', -1)
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
        expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', 0)
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
        expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', 0)
        expect(
          mainWindow.webContents.send.mock.calls.filter((call) => call[0] === 'pty:exit')
        ).toEqual([['pty:exit', { id: 'local-pty', code: 0 }]])
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
          await new Promise((resolve) => setImmediate(resolve))
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

  it('routes runtime foreground confirmation to the provider owning the captured PTY', async () => {
    const confirmForegroundProcess = vi.fn(async () => 'codex')
    registerSshPtyProvider('ssh-1', { confirmForegroundProcess } as never)
    setPtyOwnership('remote-pty', 'ssh-1')
    const runtime = { setPtyController: vi.fn() }
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      confirmForegroundProcess: (ptyId: string) => Promise<string | null>
    }

    await expect(controller.confirmForegroundProcess('remote-pty')).resolves.toBe('codex')
    expect(confirmForegroundProcess).toHaveBeenCalledOnce()
    expect(confirmForegroundProcess).toHaveBeenCalledWith('remote-pty')
    deletePtyOwnership('remote-pty')
  })

  it('returns unavailable runtime confirmation for unsupported or missing providers', async () => {
    registerSshPtyProvider('ssh-1', {} as never)
    setPtyOwnership('unsupported-pty', 'ssh-1')
    setPtyOwnership('missing-pty', 'missing-connection')
    const runtime = { setPtyController: vi.fn() }
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      confirmForegroundProcess: (ptyId: string) => Promise<string | null>
    }

    await expect(controller.confirmForegroundProcess('unsupported-pty')).resolves.toBeNull()
    await expect(controller.confirmForegroundProcess('missing-pty')).resolves.toBeNull()
    deletePtyOwnership('unsupported-pty')
    deletePtyOwnership('missing-pty')
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

  it('rejects runtime terminal IDs before unowned local provider routing', async () => {
    const shutdown = vi.spyOn(getLocalPtyProvider(), 'shutdown')
    handlers.clear()
    registerPtyHandlers(mainWindow as never)

    await expect(
      handlers.get('pty:kill')!(null, { id: 'remote:env-1@@terminal-1' })
    ).rejects.toThrow('Invalid PTY provider id')
    expect(shutdown).not.toHaveBeenCalled()
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
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:exit', {
      id: 'local-pty',
      code: -1
    })
  })

  it('does not synthesize a duplicate renderer exit when kill emits provider exit', async () => {
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

    await handlers.get('pty:kill')!(null, { id: 'local-pty' })

    expect(runtime.onPtyExit).toHaveBeenCalledTimes(1)
    expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', 0)
    expect(mainWindow.webContents.send.mock.calls.filter((call) => call[0] === 'pty:exit')).toEqual(
      [['pty:exit', { id: 'local-pty', code: 0 }]]
    )
  })

  it('ignores a late provider exit after synthesizing kill exit', async () => {
    const exitListeners = new Set<(payload: { id: string; code: number }) => void>()
    const runtime = {
      setPtyController: vi.fn(),
      onPtyExit: vi.fn()
    }
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

    await handlers.get('pty:kill')!(null, { id: 'local-pty' })
    for (const listener of exitListeners) {
      listener({ id: 'local-pty', code: 0 })
    }

    expect(runtime.onPtyExit).toHaveBeenCalledTimes(1)
    expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', -1)
    expect(mainWindow.webContents.send.mock.calls.filter((call) => call[0] === 'pty:exit')).toEqual(
      [['pty:exit', { id: 'local-pty', code: -1 }]]
    )
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
      noteTerminalSpawnCommand: vi.fn(),
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
      vi.advanceTimersByTime(2)
      daemon.emitExit(result.id, 0)

      expect(daemon.spawn).toHaveBeenCalledTimes(1)
      expect(runtime.onPtyData).toHaveBeenCalledWith(
        result.id,
        'daemon output',
        expect.any(Number),
        'daemon output'.length
      )
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

  // Why: the cap and its flag must never fire in the common case (renderer keeps
  // up), so ordinary small output carries no droppedBacklog.
  it('does not flag droppedBacklog for ordinary small output under the cap', async () => {
    vi.useFakeTimers()
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn(() => 12),
      createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-small'),
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
        { awaitLocalPtyStartup: () => Promise.resolve() }
      )
      const pendingSpawn = handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        sessionId: 'small-output-session'
      }) as Promise<{ id: string }>
      await Promise.resolve()
      const daemon = installObservableDaemonTestProvider()
      rebindLocalProviderListeners()
      const result = await pendingSpawn

      daemon.emitData(result.id, 'small output')
      await vi.advanceTimersByTimeAsync(50)

      const dataSends = mainWindow.webContents.send.mock.calls.filter(
        (call) => call[0] === 'pty:data' && (call[1] as { id: string }).id === result.id
      )
      expect(dataSends.length).toBeGreaterThan(0)
      for (const call of dataSends) {
        expect((call[1] as { droppedBacklog?: boolean }).droppedBacklog).toBeUndefined()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for the desktop startup barrier before runtime local spawns resolve the provider', async () => {
    const barrier = makeDeferred()
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
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

  it('checks single-PTY liveness without listing every session', async () => {
    const hasPty = vi.fn((id: string) => id === 'live-pty')
    const listProcesses = vi.fn(async () => {
      throw new Error('listProcesses should not be called')
    })
    setLocalPtyProvider({
      spawn: vi.fn(),
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
      listProcesses,
      attach: vi.fn(),
      hasPty,
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    registerPtyHandlers(mainWindow as never)

    await expect(handlers.get('pty:hasPty')!(null, { id: 'live-pty' })).resolves.toBe(true)
    await expect(handlers.get('pty:hasPty')!(null, { id: 'dead-pty' })).resolves.toBe(false)

    expect(hasPty).toHaveBeenCalledWith('live-pty')
    expect(hasPty).toHaveBeenCalledWith('dead-pty')
    expect(listProcesses).not.toHaveBeenCalled()
  })

  it('treats unsupported or failed single-PTY liveness as unknown', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(),
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
    registerPtyHandlers(mainWindow as never)

    await expect(handlers.get('pty:hasPty')!(null, { id: 'maybe-pty' })).resolves.toBe(null)

    const hasPty = vi.fn(() => {
      throw new Error('provider unavailable')
    })
    setLocalPtyProvider({
      spawn: vi.fn(),
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
      hasPty,
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    await expect(handlers.get('pty:hasPty')!(null, { id: 'maybe-pty' })).resolves.toBe(null)
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
      confirmForegroundProcess: vi.fn(),
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

    expect(() =>
      listenerFor('pty:write')(mainWindowIpcEvent, { id: 'remote-pty', data: 'x' })
    ).not.toThrow()
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
      confirmForegroundProcess: vi.fn(),
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
    await expect(
      handlers.get('pty:confirmForegroundProcess')!(null, { id: 'remote-pty' })
    ).resolves.toBeNull()
    expect(provider.hasChildProcesses).not.toHaveBeenCalled()
    expect(provider.getForegroundProcess).not.toHaveBeenCalled()
    expect(provider.confirmForegroundProcess).not.toHaveBeenCalled()
  })

  // Why: regression for the Claude-Code split-pane garbled-render desync. resize
  // is fire-and-forget for daemon-backed PTYs, so a corrective narrow resize can
  // be dropped while the renderer believes it landed. pty:getSize must report the
  // size the PTY ACTUALLY applied (so the renderer's resume drift-check re-asserts
  // the dropped resize) rather than the size last requested. This models a daemon
  // provider whose resize is dropped but whose getAppliedSize stays at the wide
  // spawn size; pty:getSize must surface the wide (applied) size, not the narrow
  // (requested) one.
  describe('pty:getSize reports applied size, not requested size', () => {
    function setupProviderWithAppliedSize(args: {
      applied: { cols: number; rows: number } | null
      resize?: (cols: number, rows: number) => void
      getAppliedSize?: (id: string) => Promise<{ cols: number; rows: number } | null>
    }): ReturnType<typeof vi.fn> {
      const write = vi.fn()
      setLocalPtyProvider({
        spawn: vi.fn(async (opts: { sessionId?: string }) => ({
          id: opts.sessionId ?? 'daemon-pty'
        })),
        write,
        resize: vi.fn(args.resize ?? (() => {})),
        getAppliedSize: vi.fn(args.getAppliedSize ?? (async () => args.applied)),
        kill: vi.fn(),
        shutdown: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        listProcesses: vi.fn(async () => []),
        getForegroundProcess: vi.fn(async () => null)
      } as never)
      return write
    }

    const resizeListener = (): ((event: unknown, args: unknown) => void) => {
      const call = onMock.mock.calls.find((entry: unknown[]) => entry[0] === 'pty:resize')
      if (!call) {
        throw new Error('missing pty:resize listener')
      }
      return call[1] as (event: unknown, args: unknown) => void
    }

    it('returns the applied (wide) size after a dropped narrow resize', async () => {
      // The daemon keeps the PTY at its wide spawn size; the narrow resize is
      // silently dropped (provider.resize is a no-op fire-and-forget).
      setupProviderWithAppliedSize({ applied: { cols: 200, rows: 50 } })
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 200, rows: 50, env: {} })
      const id = (spawn as { id: string }).id

      // Renderer forwards a corrective narrow resize; it is dropped daemon-side.
      resizeListener()(mainWindowIpcEvent, { id, cols: 80, rows: 24 })

      // pty:getSize must surface the applied wide size so the renderer detects
      // drift (xterm=80 vs PTY=200) and re-asserts — NOT the requested 80.
      const reported = await handlers.get('pty:getSize')!(null, { id })
      expect(reported).toEqual({ cols: 200, rows: 50 })
    })

    it('falls back to the requested size when the provider cannot report applied size', async () => {
      // No getAppliedSize (e.g. SSH relay): the requested-size cache is the only
      // signal, so getSize returns it — preserving prior behavior, not a regression.
      setupProviderWithAppliedSize({ applied: null, getAppliedSize: undefined })
      setLocalPtyProvider({
        spawn: vi.fn(async (opts: { sessionId?: string }) => ({
          id: opts.sessionId ?? 'daemon-pty'
        })),
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
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 200, rows: 50, env: {} })
      const id = (spawn as { id: string }).id
      resizeListener()(mainWindowIpcEvent, { id, cols: 80, rows: 24 })

      const reported = await handlers.get('pty:getSize')!(null, { id })
      expect(reported).toEqual({ cols: 80, rows: 24 })
    })

    it('falls back to the requested size when getAppliedSize throws', async () => {
      // A dead daemon/relay must never throw across the IPC boundary or block.
      setupProviderWithAppliedSize({
        applied: null,
        getAppliedSize: async () => {
          throw new Error('daemon unreachable')
        }
      })
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 100, rows: 30, env: {} })
      const id = (spawn as { id: string }).id

      const reported = await handlers.get('pty:getSize')!(null, { id })
      expect(reported).toEqual({ cols: 100, rows: 30 })
    })

    it('fans out accepted desktop resizes to the runtime after provider resize', async () => {
      const resize = vi.fn()
      setupProviderWithAppliedSize({ applied: { cols: 120, rows: 30 }, resize })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'host' })),
        isResizeSuppressed: vi.fn(() => false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        onExternalPtyResize: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id

      resizeListener()(mainWindowIpcEvent, { id, cols: 120, rows: 30 })

      expect(resize).toHaveBeenCalledWith(id, 120, 30)
      expect(runtime.onExternalPtyResize).toHaveBeenCalledWith(id, 120, 30)
      expect(resize.mock.invocationCallOrder[0]).toBeLessThan(
        runtime.onExternalPtyResize.mock.invocationCallOrder[0]!
      )
    })

    it('does not fan out rejected desktop resizes to the runtime', async () => {
      setupProviderWithAppliedSize({
        applied: { cols: 80, rows: 24 },
        resize: () => {
          throw new Error('resize rejected')
        }
      })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'host' })),
        isResizeSuppressed: vi.fn(() => false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        onExternalPtyResize: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id

      resizeListener()(mainWindowIpcEvent, { id, cols: 120, rows: 30 })

      expect(runtime.onExternalPtyResize).not.toHaveBeenCalled()
    })

    it('suppresses the host fit cascade while a remote viewer drives the width', async () => {
      const resizeSpy = vi.fn()
      setupProviderWithAppliedSize({ applied: { cols: 80, rows: 24 }, resize: resizeSpy })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'idle' })),
        // The whole point of the fix: a PTY with a remote viewer reports true,
        // even though the presence-lock driver state stays idle/desktop.
        isRemoteDesktopResizeDriven: vi.fn(() => true),
        isResizeSuppressed: vi.fn(() => false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        recordRemoteDesktopHostReclaimTarget: vi.fn(),
        onExternalPtyResize: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id
      resizeSpy.mockClear()

      // Host's own safeFit tries to widen the viewed PTY back to its window.
      resizeListener()(mainWindowIpcEvent, { id, cols: 125, rows: 48 })

      // It must not reach the PTY while the viewer owns the width.
      expect(resizeSpy).not.toHaveBeenCalled()
      expect(runtime.recordRemoteDesktopHostReclaimTarget).toHaveBeenCalledWith(id, 125, 48)
      expect(runtime.onExternalPtyResize).not.toHaveBeenCalled()
    })

    it('lets trusted host activity reclaim remote viewport ownership', () => {
      const claimRemoteDesktopHost = vi.fn().mockResolvedValue(true)
      const runtime = {
        setPtyController: vi.fn(),
        claimRemoteDesktopHost
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const call = onMock.mock.calls.find((entry: unknown[]) => entry[0] === 'pty:claimViewport')
      const claimListener = call?.[1] as
        | ((event: unknown, args: { id: string; cols: number; rows: number }) => void)
        | undefined
      expect(claimListener).toBeTypeOf('function')

      claimListener?.(mainWindowIpcEvent, { id: 'pty-1', cols: 125, rows: 48 })

      expect(claimRemoteDesktopHost).toHaveBeenCalledWith('pty-1', 125, 48)
    })

    it('does not forward host input when viewport reclaim fails', async () => {
      const write = setupProviderWithAppliedSize({ applied: { cols: 80, rows: 24 } })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'idle' })),
        claimRemoteDesktopHost: vi.fn().mockResolvedValue(false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id
      const claim = onMock.mock.calls.find((entry: unknown[]) => entry[0] === 'pty:claimViewport')
      const writeEvent = onMock.mock.calls.find((entry: unknown[]) => entry[0] === 'pty:write')

      claim?.[1](mainWindowIpcEvent, { id, cols: 125, rows: 48 })
      writeEvent?.[1](mainWindowIpcEvent, { id, data: 'x' })
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
    })

    it('does not populate the remote reclaim cache when only a phone drives', async () => {
      const resizeSpy = vi.fn()
      setupProviderWithAppliedSize({ applied: { cols: 80, rows: 24 }, resize: resizeSpy })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'mobile', clientId: 'phone-A' })),
        isRemoteDesktopResizeDriven: vi.fn(() => false),
        isResizeSuppressed: vi.fn(() => false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        recordRemoteDesktopHostReclaimTarget: vi.fn(),
        onExternalPtyResize: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id
      resizeSpy.mockClear()

      resizeListener()(mainWindowIpcEvent, { id, cols: 125, rows: 48 })

      expect(resizeSpy).not.toHaveBeenCalled()
      expect(runtime.recordRemoteDesktopHostReclaimTarget).not.toHaveBeenCalled()
      expect(runtime.onExternalPtyResize).not.toHaveBeenCalled()
    })
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
      noteTerminalSpawnCommand: vi.fn(),
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

  it('refreshes captured native Agent Teams env for renderer PTY spawns', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const runtime = {
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_agent_teams'),
      prepareClaudeAgentTeamsLeaderForHandle: vi.fn(async () => ({
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          PATH: `/tmp/fresh-agent-teams${delimiter}/usr/bin`,
          TMUX: '/tmp/orca-claude-agent-teams/team-fresh,0,1',
          TMUX_PANE: '%1',
          ORCA_AGENT_TEAMS_TEAM_ID: 'team-fresh',
          ORCA_AGENT_TEAMS_TOKEN: 'fresh-token'
        }
      })),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    const result = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24,
      cwd: '/repo',
      command: 'claude --teammate-mode auto --resume claude-session',
      tabId: 'tab-1',
      leafId,
      worktreeId: 'wt-1',
      env: {
        ORCA_PANE_KEY: `tab-1:${leafId}`,
        ORCA_TAB_ID: 'tab-1',
        ORCA_WORKTREE_ID: 'wt-1',
        CLAUDE_PROFILE: 'captured',
        PATH: `/tmp/stale-agent-teams${delimiter}/usr/bin`,
        TMUX: '/tmp/orca-claude-agent-teams/team-stale,0,1',
        ORCA_AGENT_TEAMS_TEAM_ID: 'team-stale',
        ORCA_AGENT_TEAMS_TOKEN: 'stale-token',
        TERM_PROGRAM: 'Orca',
        ORCA_ATTRIBUTION_SHIM_DIR: '/tmp/stale-attribution'
      },
      launchConfig: {
        agentCommand: 'claude --teammate-mode auto',
        agentArgs: '',
        agentEnv: {
          CLAUDE_PROFILE: 'captured',
          ORCA_AGENT_TEAMS_TEAM_ID: 'team-stale',
          ORCA_AGENT_TEAMS_TOKEN: 'stale-token'
        }
      },
      launchAgent: 'claude'
    })) as { launchConfig?: { agentEnv: Record<string, string> } }

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as { env: Record<string, string> }
    expect(runtime.prepareClaudeAgentTeamsLeaderForHandle).toHaveBeenCalledWith({
      handle: 'term_agent_teams',
      baseEnv: expect.objectContaining({
        CLAUDE_PROFILE: 'captured',
        ORCA_AGENT_TEAMS_TEAM_ID: 'team-stale'
      })
    })
    expect(spawnOptions.env).toMatchObject({
      CLAUDE_PROFILE: 'captured',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      ORCA_TERMINAL_HANDLE: 'term_agent_teams',
      ORCA_AGENT_TEAMS_TEAM_ID: 'team-fresh',
      ORCA_AGENT_TEAMS_TOKEN: 'fresh-token',
      TMUX: '/tmp/orca-claude-agent-teams/team-fresh,0,1',
      TMUX_PANE: '%1'
    })
    expect(spawnOptions.env.PATH.split(delimiter)[0]).toBe('/tmp/fresh-agent-teams')
    expect(spawnOptions.env.TERM_PROGRAM).toBeUndefined()
    expect(spawnOptions.env.ORCA_ATTRIBUTION_SHIM_DIR).toBeUndefined()
    expect(result.launchConfig?.agentEnv).toMatchObject({
      CLAUDE_PROFILE: 'captured',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      ORCA_AGENT_TEAMS_TEAM_ID: 'team-fresh',
      ORCA_AGENT_TEAMS_TOKEN: 'fresh-token',
      TMUX: '/tmp/orca-claude-agent-teams/team-fresh,0,1'
    })
    expect(runtime.registerPreAllocatedHandleForPty).toHaveBeenCalledWith(
      expect.any(String),
      'term_agent_teams'
    )
  })

  it('threads the validated pane identity into registerPty for a renderer PTY spawn (#7587)', async () => {
    const leafId = '88888888-8888-4888-8888-888888888888'
    const runtime = {
      setPtyController: vi.fn(),
      preAllocateHandleForPty: vi.fn(() => 'term_seam'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24,
      cwd: '/repo',
      tabId: 'tab-1',
      leafId,
      worktreeId: 'wt-1'
    })

    // Why: this is the load-bearing wiring for #7587 — the runtime can only back a
    // stalled mobile create from a live spawn if the spawn threads {tabId, leafId}.
    expect(runtime.registerPty).toHaveBeenCalledWith(
      expect.any(String),
      'wt-1',
      null,
      { tabId: 'tab-1', leafId },
      false
    )
  })

  it('omits the pane identity from registerPty when the leafId is not a terminal leaf (#7587)', async () => {
    const runtime = {
      setPtyController: vi.fn(),
      preAllocateHandleForPty: vi.fn(() => 'term_seam'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24,
      cwd: '/repo',
      tabId: 'tab-1',
      leafId: 'pane:1',
      worktreeId: 'wt-1'
    })

    // Why: legacy numeric pane ids (`pane:N`) are not terminal leaf ids, so the
    // spawn seam must not fabricate a binding for them (registerPty would ignore
    // it anyway); this pins that the seam passes a clean `undefined`.
    expect(runtime.registerPty).toHaveBeenCalledWith(
      expect.any(String),
      'wt-1',
      null,
      undefined,
      false
    )
  })

  it('refreshes native Agent Teams env when captured teammate mode lives in launch args', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const runtime = {
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_agent_teams'),
      prepareClaudeAgentTeamsLeaderForHandle: vi.fn(async () => ({
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          ORCA_AGENT_TEAMS_TEAM_ID: 'team-fresh',
          ORCA_AGENT_TEAMS_TOKEN: 'fresh-token'
        }
      })),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24,
      cwd: '/repo',
      command: 'claude --resume claude-session',
      tabId: 'tab-1',
      leafId,
      worktreeId: 'wt-1',
      env: {
        ORCA_PANE_KEY: `tab-1:${leafId}`,
        ORCA_TAB_ID: 'tab-1',
        ORCA_WORKTREE_ID: 'wt-1'
      },
      launchConfig: {
        agentCommand: 'claude',
        agentArgs: '--teammate-mode auto',
        agentEnv: {}
      },
      launchAgent: 'claude'
    })

    expect(runtime.prepareClaudeAgentTeamsLeaderForHandle).toHaveBeenCalledWith({
      handle: 'term_agent_teams',
      baseEnv: expect.any(Object)
    })
  })

  it('does not echo launch config for provider reattach results', async () => {
    const spawn = vi.fn(async () => ({ id: 'ssh-reattach', isReattach: true }))
    registerSshPtyProvider('ssh-reattach-1', {
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
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      connectionId: 'ssh-reattach-1',
      launchConfig: {
        agentCommand: 'codex --model gpt-5',
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      }
    })) as { id: string; isReattach?: boolean; launchConfig?: unknown }

    expect(result).toMatchObject({ id: 'ssh-reattach', isReattach: true })
    expect(result.launchConfig).toBeUndefined()
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
      noteTerminalSpawnCommand: vi.fn(),
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
      noteTerminalSpawnCommand: vi.fn(),
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
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_trusted'),
      preAllocateHandleForPty: vi.fn(() => 'term_trusted'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
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

  it('reuses runtime materialization when renderer focuses the same pane during spawn', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        cwd?: string
        worktreeId?: string
        env?: Record<string, string>
        tabId?: string
        leafId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    let resolveSpawn!: (result: { id: string }) => void
    const providerSpawn = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveSpawn = resolve
        })
    )
    setLocalPtyProvider({
      spawn: providerSpawn,
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
    const store = {
      persistPtyBinding: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_trusted'),
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
    const leafId = '22222222-2222-4222-8222-222222222222'
    const paneKey = makePaneKey('tab-race', leafId)
    const runtimeSpawn = spawnController.spawn({
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      worktreeId: 'repo-1::/tmp',
      tabId: 'tab-race',
      leafId,
      env: { ORCA_PANE_KEY: paneKey },
      persistHostSessionBinding: true
    })
    await Promise.resolve()

    // Why: SSH can strip ORCA_PANE_KEY before spawn; tab/leaf metadata must
    // still dedupe against runtime materialization.
    const rendererSpawn = handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      worktreeId: 'repo-1::/tmp',
      tabId: 'tab-race',
      leafId,
      env: {
        ORCA_TAB_ID: 'tab-race',
        ORCA_WORKTREE_ID: 'repo-1::/tmp'
      }
    }) as Promise<{ id: string }>
    await Promise.resolve()

    expect(providerSpawn).toHaveBeenCalledTimes(1)
    resolveSpawn({ id: 'pty-shared' })
    await expect(Promise.all([runtimeSpawn, rendererSpawn])).resolves.toEqual([
      { id: 'pty-shared' },
      { id: 'pty-shared' }
    ])
    expect(providerSpawn).toHaveBeenCalledTimes(1)
    expect(store.persistPtyBinding).toHaveBeenCalledWith({
      worktreeId: 'repo-1::/tmp',
      tabId: 'tab-race',
      leafId,
      ptyId: 'pty-shared',
      startupCwd: '/tmp'
    })
  })

  it('reuses renderer spawn when runtime materialization starts for the same pane', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        cwd?: string
        worktreeId?: string
        env?: Record<string, string>
        tabId?: string
        leafId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    let resolveSpawn!: (result: { id: string }) => void
    const providerSpawn = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveSpawn = resolve
        })
    )
    setLocalPtyProvider({
      spawn: providerSpawn,
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
    const store = {
      persistPtyBinding: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_trusted'),
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
    const leafId = '33333333-3333-4333-8333-333333333333'
    const paneKey = makePaneKey('tab-race', leafId)
    const rendererSpawn = handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      worktreeId: 'repo-1::/tmp',
      tabId: 'tab-race',
      leafId,
      env: {
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: 'tab-race',
        ORCA_WORKTREE_ID: 'repo-1::/tmp'
      }
    }) as Promise<{ id: string }>
    await Promise.resolve()

    const spawnController = controller as unknown as RuntimeSpawnController
    const runtimeSpawn = spawnController.spawn({
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      worktreeId: 'repo-1::/tmp',
      tabId: 'tab-race',
      leafId,
      env: { ORCA_PANE_KEY: paneKey },
      persistHostSessionBinding: true
    })
    await Promise.resolve()

    expect(providerSpawn).toHaveBeenCalledTimes(1)
    resolveSpawn({ id: 'pty-renderer' })
    await expect(Promise.all([rendererSpawn, runtimeSpawn])).resolves.toEqual([
      { id: 'pty-renderer' },
      { id: 'pty-renderer' }
    ])
    expect(providerSpawn).toHaveBeenCalledTimes(1)
    expect(store.persistPtyBinding).toHaveBeenCalledWith({
      worktreeId: 'repo-1::/tmp',
      tabId: 'tab-race',
      leafId,
      ptyId: 'pty-renderer',
      startupCwd: '/tmp'
    })
  })

  it('settles the pane reservation when a post-spawn step throws so later spawns do not hang', async () => {
    // Why: regression for the reservation leak — if a post-spawn helper throws
    // after provider.spawn resolves (here registerPty), the reservation must be
    // rejected and cleared. Otherwise every later spawn for the same pane key
    // awaits a promise that never settles and the tab hangs forever.
    registerPtyHandlers(mainWindow as never)
    const leafId = '44444444-4444-4444-8444-444444444444'
    const spawnArgs = { cols: 80, rows: 24, tabId: 'tab-reservation', leafId }

    registerPtyMock.mockImplementationOnce(() => {
      throw new Error('boom: post-spawn registration failed')
    })

    await expect(handlers.get('pty:spawn')!(null, spawnArgs)).rejects.toThrow('boom')

    // A second spawn for the same pane must run a fresh spawn rather than await
    // the leaked (never-settled) reservation promise.
    let hangTimer: ReturnType<typeof setTimeout> | undefined
    const second = handlers.get('pty:spawn')!(null, spawnArgs) as Promise<{ id: string }>
    const result = await Promise.race([
      second,
      new Promise<never>((_, reject) => {
        hangTimer = setTimeout(
          () => reject(new Error('second spawn hung: pane reservation leaked')),
          1000
        )
      })
    ]).finally(() => clearTimeout(hangTimer))

    expect(result.id).toEqual(expect.any(String))
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('settles the runtime-owned pane reservation when a post-spawn step throws so later spawns do not hang', async () => {
    // Why: symmetry with the renderer-path regression — the runtime-controller
    // spawn path keeps its own reservation, so it must also reject and clear it
    // when a post-spawn helper (here runtime.registerPty) throws after
    // provider.spawn resolves. Otherwise the next materialization for the same
    // pane awaits a promise that never settles.
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        cwd?: string
        worktreeId?: string
        env?: Record<string, string>
        tabId?: string
        leafId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    let spawnCount = 0
    const providerSpawn = vi.fn(async () => ({ id: `pty-${++spawnCount}` }))
    setLocalPtyProvider({
      spawn: providerSpawn,
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
    const store = {
      persistPtyBinding: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_trusted'),
      preAllocateHandleForPty: vi.fn(() => 'term_trusted'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn().mockImplementationOnce(() => {
        throw new Error('boom: runtime registration failed')
      }),
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
    const leafId = '55555555-5555-4555-8555-555555555555'
    const paneKey = makePaneKey('tab-runtime-reservation', leafId)
    const spawnArgs = {
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      worktreeId: 'wt-1',
      tabId: 'tab-runtime-reservation',
      leafId,
      env: { ORCA_PANE_KEY: paneKey },
      persistHostSessionBinding: true
    }

    await expect(spawnController.spawn(spawnArgs)).rejects.toThrow('boom')

    // The reservation must be gone, so a second materialization runs a fresh
    // provider.spawn instead of awaiting the leaked promise.
    let hangTimer: ReturnType<typeof setTimeout> | undefined
    const second = spawnController.spawn(spawnArgs)
    const result = await Promise.race([
      second,
      new Promise<never>((_, reject) => {
        hangTimer = setTimeout(
          () => reject(new Error('second runtime spawn hung: pane reservation leaked')),
          1000
        )
      })
    ]).finally(() => clearTimeout(hangTimer))
    expect(result.id).toEqual(expect.any(String))
    expect(providerSpawn).toHaveBeenCalledTimes(2)
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
      noteTerminalSpawnCommand: vi.fn(),
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
      noteTerminalSpawnCommand: vi.fn(),
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
      noteTerminalSpawnCommand: vi.fn(),
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
      noteTerminalSpawnCommand: vi.fn(),
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
      noteTerminalSpawnCommand: vi.fn(),
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
    getPtyWriteListener()(mainWindowIpcEvent, {
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
      noteTerminalSpawnCommand: vi.fn(),
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
      getPtyWriteListener()(mainWindowIpcEvent, { id: appPtyId, data: 'echo nope' })
      expect(remoteWrite).not.toHaveBeenCalled()
    } finally {
      deletePtyOwnership(appPtyId)
      unregisterSshPtyProvider('ssh-expired-runtime')
    }
  })

  it('does not clear runtime-owned SSH reattach state on identity mismatch', async () => {
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
    const connectionId = 'ssh-identity-runtime'
    const appPtyId = `ssh:${connectionId}@@relay-pty`
    const remoteWrite = vi.fn()
    registerSshPtyProvider(connectionId, {
      spawn: vi.fn(async () => {
        throw new Error(
          `${SSH_SESSION_EXPIRED_ERROR}: relay-pty ${SSH_PTY_IDENTITY_MISMATCH_ERROR}`
        )
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
      setPtyOwnership(appPtyId, connectionId)
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
          connectionId,
          worktreeId: 'wt-remote',
          tabId: 'tab-remote',
          leafId,
          sessionId: appPtyId,
          persistHostSessionBinding: true
        })
      ).rejects.toThrow(SSH_SESSION_EXPIRED_ERROR)

      expect(store.markSshRemotePtyLease).not.toHaveBeenCalledWith(
        connectionId,
        'relay-pty',
        'expired'
      )
      expect(store.upsertSshRemotePtyLease).not.toHaveBeenCalled()
      expect(store.persistPtyBinding).not.toHaveBeenCalled()
      expect(openCodeClearPtyMock).not.toHaveBeenCalledWith(appPtyId)
      expect(piClearPtyMock).not.toHaveBeenCalledWith(appPtyId)
      getPtyWriteListener()(mainWindowIpcEvent, { id: appPtyId, data: 'echo still-owned' })
      expect(remoteWrite).toHaveBeenCalledWith(appPtyId, 'echo still-owned')
    } finally {
      deletePtyOwnership(appPtyId)
      unregisterSshPtyProvider(connectionId)
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
      noteTerminalSpawnCommand: vi.fn(),
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
      noteTerminalSpawnCommand: vi.fn(),
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
      noteTerminalSpawnCommand: vi.fn(),
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
      noteTerminalSpawnCommand: vi.fn(),
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
    expect(env.ORCA_USER_DATA_PATH).toBe('/tmp/orca-user-data')
    expect(env.ORCA_CLI_COMMAND).toBe('orca-ide')
    expect(env.WSLENV?.split(':')).toEqual(
      expect.arrayContaining([
        'ORCA_TERMINAL_HANDLE/u',
        'ORCA_USER_DATA_PATH/p',
        'ORCA_CLI_COMMAND/u',
        'ORCA_AGENT_HOOK_PORT/u',
        'ORCA_AGENT_HOOK_TOKEN/u',
        'ORCA_OMP_SOURCE_AGENT_DIR/p',
        'ORCA_OMP_STATUS_EXTENSION/p',
        'POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD'
      ])
    )
  })

  it('forces managed ORCA_USER_DATA_PATH for WSL spawns even when the caller provides a stale root', async () => {
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
        shellOverride: 'wsl.exe',
        env: {
          ORCA_USER_DATA_PATH: '/tmp/stale-orca-user-data'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const spawnCall = spawnMock.mock.calls.at(-1)!
    const env = spawnCall[2].env as Record<string, string>
    expect(spawnCall[0]).toBe('wsl.exe')
    expect(env.ORCA_USER_DATA_PATH).toBe('/tmp/orca-user-data')
  })

  describe('Windows UTF-8 code page', () => {
    let originalPlatform: string
    let originalComspec: string | undefined
    const savedWindowsResolutionEnv: Record<string, string | undefined> = {}

    beforeEach(() => {
      originalPlatform = process.platform
      originalComspec = process.env.COMSPEC
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })
      process.env.USERPROFILE = 'C:\\Users\\test'
      // Why: the production spawn path resolves a bare PowerShell family name to
      // a real absolute executable (PR #6537 / issue #5161). Pin the install
      // roots it probes so the resolved path is deterministic regardless of the
      // host OS the suite runs on (CI verify runs on Linux, devs on Windows).
      for (const key of ['SystemRoot', 'ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
        savedWindowsResolutionEnv[key] = process.env[key]
      }
      process.env.SystemRoot = 'C:\\Windows'
      process.env.ProgramW6432 = 'C:\\Program Files'
      process.env.ProgramFiles = 'C:\\Program Files'
      delete process.env['ProgramFiles(x86)']
      // Why: the resolver treats any existing, non-zero-size `.exe` outside the
      // Microsoft Store WindowsApps alias dir as a real executable. Directories
      // (cwd validation) must still report isDirectory(); the default mock omits
      // isFile()/size, which would make every PowerShell candidate fail to
      // resolve and collapse the chain to cmd.exe.
      statSyncMock.mockImplementation((target: string) => {
        const isExe = /\.exe$/i.test(String(target))
        return {
          isDirectory: () => !isExe,
          isFile: () => isExe,
          size: isExe ? 1024 : 0,
          mode: 0o755
        }
      })
      existsSyncMock.mockReturnValue(true)
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
      for (const [key, value] of Object.entries(savedWindowsResolutionEnv)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
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
        RESOLVED_WINDOWS_POWERSHELL,
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
        RESOLVED_WINDOWS_POWERSHELL,
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

      expect(spawnMock).toHaveBeenCalledWith(
        RESOLVED_PWSH7,
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })

    it('keeps PowerShell 7 selected when the pwsh availability probe is cold-false', async () => {
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
        RESOLVED_PWSH7,
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
      expect(isPwshAvailableMock).not.toHaveBeenCalled()
    })

    it('keeps a pwsh.exe shellOverride when the pwsh availability probe is cold-false', async () => {
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
        RESOLVED_PWSH7,
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
      expect(isPwshAvailableMock).not.toHaveBeenCalled()
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

  it('passes floating terminal cwds through to the spawned shell', async () => {
    // Why: the floating sentinel has no worktree root; its cwd is validated
    // against trusted-directory grants before it reaches pty:spawn.
    registerPtyHandlers(mainWindow as never)

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp/floating-notes',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    const [, , options] = spawnMock.mock.calls.at(-1) as [string, string[], { cwd: string }]
    expect(options.cwd).toBe('/tmp/floating-notes')
  })

  it('falls back to the worktree root when a saved local cwd no longer exists', async () => {
    registerPtyHandlers(mainWindow as never)
    // Why: issue #7239 reproduced in a Japanese-named worktree; the fallback
    // must return the selected worktree path verbatim.
    const worktreePath = '/Users/motoki/orca/workspaces/nakamuramotoki/Fableと議論'
    const missingCwd = `${worktreePath}/deleted-folder`
    statSyncMock.mockImplementation((target: string) => {
      if (target === missingCwd) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true, mode: 0o755 }
    })

    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: missingCwd,
      cwdFallback: 'worktree',
      worktreeId: `repo-1::${worktreePath}`
    })) as { startupCwdFallback?: { kind: string; cwd: string } }

    const [, , options] = spawnMock.mock.calls.at(-1) as [string, string[], { cwd: string }]
    expect(options.cwd).toBe(worktreePath)
    expect(result.startupCwdFallback).toEqual({ kind: 'worktree', cwd: worktreePath })
  })

  it('keeps a missing cwd unchanged without the fallback flag', async () => {
    registerPtyHandlers(mainWindow as never)
    existsSyncMock.mockImplementation((target: string) => target !== '/repo/app/deleted-folder')
    statSyncMock.mockImplementation((target: string) => {
      if (target === '/repo/app/deleted-folder') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true, mode: 0o755 }
    })

    // Why: without the renderer opt-in the provider still surfaces its normal
    // missing-directory error — API/runtime callers keep exact cwd semantics.
    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/repo/app/deleted-folder',
        worktreeId: 'repo-1::/repo/app'
      })
    ).rejects.toThrow('Working directory "/repo/app/deleted-folder" does not exist.')

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('spawns at an existing outside-worktree cwd without falling back (#7685)', async () => {
    registerPtyHandlers(mainWindow as never)

    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/repo/app-other',
      cwdFallback: 'worktree',
      worktreeId: 'repo-1::/repo/app'
    })) as { startupCwdFallback?: unknown }

    const [, , options] = spawnMock.mock.calls.at(-1) as [string, string[], { cwd: string }]
    expect(options.cwd).toBe('/repo/app-other')
    expect(result.startupCwdFallback).toBeUndefined()
  })

  it('ignores the cwd fallback flag for session reattach spawns', async () => {
    registerPtyHandlers(mainWindow as never)
    existsSyncMock.mockImplementation((target: string) => target !== '/repo/app/deleted-folder')
    statSyncMock.mockImplementation((target: string) => {
      if (target === '/repo/app/deleted-folder') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true, mode: 0o755 }
    })

    // Why: a reattach must keep the session's exact cwd; remapping it would
    // silently detach the restored terminal from its recorded state.
    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/repo/app/deleted-folder',
        cwdFallback: 'worktree',
        sessionId: 'session-1',
        worktreeId: 'repo-1::/repo/app'
      })
    ).rejects.toThrow('Working directory "/repo/app/deleted-folder" does not exist.')

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects missing WSL worktree cwd instead of validating only the fallback Windows cwd', async () => {
    const originalPlatform = process.platform
    const originalUserProfile = process.env.USERPROFILE

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    process.env.USERPROFILE = 'C:\\Users\\jinwo'

    // Why: the startup-cwd guard normalizes separators, so the provider sees
    // the forward-slash UNC form.
    existsSyncMock.mockImplementation((targetPath: string) => {
      if (targetPath === '//wsl.localhost/Ubuntu/home/jin/missing') {
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
          cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing',
          worktreeId: 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\jin'
        })
      ).rejects.toThrow(
        'Working directory "//wsl.localhost/Ubuntu/home/jin/missing" does not exist.'
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
    const originalHome = process.env.HOME
    const originalOrcaOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    const originalShell = process.env.SHELL
    const originalZdotdir = process.env.ZDOTDIR

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    // Why: this test simulates macOS even when Vitest runs on a Windows host.
    process.env.HOME = '/Users/test'
    delete process.env.ORCA_ORIG_ZDOTDIR
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
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      if (originalOrcaOrigZdotdir === undefined) {
        delete process.env.ORCA_ORIG_ZDOTDIR
      } else {
        process.env.ORCA_ORIG_ZDOTDIR = originalOrcaOrigZdotdir
      }
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

  posixOnlyIt('wraps macOS spawns in login(1) with SHELL re-asserted via env(1)', async () => {
    const originalShell = process.env.SHELL
    // Re-enable the TCC login wrapper the suite-level beforeEach disables.
    delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    process.env.SHELL = '/bin/zsh'

    try {
      const [file, args, options] = await spawnAndGetCall({ cwd: '/tmp' })
      expect(file).toBe('/usr/bin/login')
      expect(args).toEqual([
        '-flpq',
        userInfo().username,
        '/usr/bin/env',
        'SHELL=/bin/zsh',
        '/bin/zsh',
        '-l'
      ])
      // The spawn env keeps the real shell so identity/name logic is intact.
      expect(options.env.SHELL).toBe('/bin/zsh')
    } finally {
      process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = '1'
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
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
      vi.advanceTimersByTime(50)
      await Promise.resolve()
      expect(mockProc.proc.write).not.toHaveBeenCalled()

      vi.advanceTimersByTime(150)
      await Promise.resolve()
      expect(mockProc.proc.write).toHaveBeenCalledWith("codex 'linked issue context'\n")
    } finally {
      vi.useRealTimers()
    }
  })

  posixOnlyIt(
    'uses the short settle path for delivery-hinted Codex when prompt follows the marker',
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
          command: "codex 'linked issue context'",
          startupCommandDelivery: 'shell-ready'
        })

        mockProc.emitData('\x1b]777;orca-shell-ready\x07\r\nuser@host % ')
        await Promise.resolve()
        vi.advanceTimersByTime(29)
        await Promise.resolve()
        expect(mockProc.proc.write).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        await Promise.resolve()
        expect(mockProc.proc.write).toHaveBeenCalledWith("codex 'linked issue context'\n")
      } finally {
        vi.useRealTimers()
      }
    }
  )

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
      vi.advanceTimersByTime(1)
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

  it('preserves background-origin metadata when hidden output flushes after resume', async () => {
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
      const setRendererPtyVisible = getPtySetRendererPtyVisibleListener()
      mainWindow.webContents.send.mockClear()

      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      mockProc.emitData('visible output')
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'visible output'
      })

      mainWindow.webContents.send.mockClear()
      setRendererPtyVisible(null, { id: spawnResult.id, visible: false })
      mockProc.emitData('\x1b[2Khidden-width redraw')
      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: '\x1b[2Khidden-width redraw',
        background: true
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks visible renderer PTYs hidden while the renderer lifecycle resets', async () => {
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
      const setRendererPtyVisible = getPtySetRendererPtyVisibleListener()
      const handleRendererLoading = getMainWindowWebContentsListener('did-start-loading')
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      mainWindow.webContents.send.mockClear()

      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      handleRendererLoading()
      // Reloaded page's dispatcher re-registers, releasing held sends (§1b).
      handleRendererDispatcherReady()
      mockProc.emitData('reload-gap output')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'reload-gap output',
        background: true
      })

      mainWindow.webContents.send.mockClear()
      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      mockProc.emitData('visible output')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'visible output'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets leaked delivery accounting on renderer lifecycle reset so a saturated PTY resumes', async () => {
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
      const handleRendererLoading = getMainWindowWebContentsListener('did-start-loading')
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      // Drain the initial dispatcher-ready flush (beforeEach fires the handshake
      // to model a live page) so the flood timing below starts from a clean slate.
      vi.advanceTimersByTime(1)
      mainWindow.webContents.send.mockClear()

      // Saturate the PTY past the 512 KB per-PTY high-water with no ACKs.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }

      // Gate closed: sends stop at the cap and the remainder accrues as pending.
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      vi.advanceTimersByTime(1)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      expect(vi.getTimerCount()).toBe(0)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        pendingChars: 88 * 1024,
        pendingPtyCount: 1,
        rendererLifecycleResetCount: 0,
        lastLifecycleResetClearedChars: 0
      })

      // Renderer reload: the dead page never ACKs, so its in-flight/pending
      // accounting must clear or the surviving PTY stays delivery-gated forever.
      handleRendererLoading()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        rendererInFlightPtyCount: 0,
        pendingChars: 0,
        pendingPtyCount: 0,
        rendererLifecycleResetCount: 1,
        lastLifecycleResetClearedChars: 512 * 1024
      })

      // Boot window (§1b): the reloaded page's dispatcher has not re-registered
      // yet, so main must hold sends — bytes sent into the listener-less page are
      // dropped but still counted in-flight, which would re-pin the gate. The
      // output must accrue in pending, unsent and NOT counted in-flight.
      mainWindow.webContents.send.mockClear()
      mockProc.emitData('post-reload output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: 'post-reload output'.length,
        pendingPtyCount: 1
      })

      // The reloaded page's dispatcher-ready handshake releases the held backlog.
      // Counters-zero alone is insufficient — prove delivery actually resumes and
      // the pending backlog drains (bytes now correctly counted in-flight, the
      // mirror image of the NOT-counted boot-window hold above).
      handleRendererDispatcherReady()
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-reload output'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 'post-reload output'.length,
        pendingChars: 0,
        pendingPtyCount: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a subframe did-start-loading (isLoadingMainFrame false) so an in-page iframe load cannot freeze delivery', async () => {
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
      const handleRendererLoading = getMainWindowWebContentsListener('did-start-loading')
      const ackData = getPtyAckDataListener()
      // Drain the initial dispatcher-ready flush (beforeEach fires the handshake).
      vi.advanceTimersByTime(1)
      mainWindow.webContents.send.mockClear()

      // Saturate the PTY past the 512 KB per-PTY high-water with no ACKs.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)

      // A sandboxed srcDoc iframe (notebook HTML output) loading fires
      // did-start-loading with isLoadingMainFrame() === false. This is NOT a
      // renderer lifecycle reset: the still-alive page keeps its dispatcher, so
      // clearing accounting or dropping the ready flag here would freeze every
      // pane for the whole watchdog window. Nothing must change.
      mainWindow.webContents.isLoadingMainFrame.mockReturnValueOnce(false)
      handleRendererLoading()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        pendingChars: 88 * 1024,
        pendingPtyCount: 1,
        rendererLifecycleResetCount: 0,
        lastLifecycleResetClearedChars: 0,
        rendererPtyDispatcherReady: true
      })

      // The gate is still open: ACKing the in-flight cap drains the held backlog
      // (a spurious reset would have cleared pending and dropped ready, so this
      // send would never fire).
      mainWindow.webContents.send.mockClear()
      ackData(null, { id: spawnResult.id, charCount: 512 * 1024 })
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconciles stale delivery accounting when a fresh dispatcher-ready handshake arrives while the gate is still open (missed lifecycle reset)', async () => {
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
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      const ackData = getPtyAckDataListener()
      // Drain the initial dispatcher-ready flush (beforeEach fires the handshake).
      vi.advanceTimersByTime(1)
      mainWindow.webContents.send.mockClear()

      // Saturate the PTY past the 512 KB per-PTY high-water with no ACKs.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        pendingChars: 88 * 1024,
        rendererLifecycleResetCount: 0,
        rendererPtyDispatcherReady: true
      })

      // A main-frame reload overlapped by an in-page subframe load emits no
      // did-start-loading, so the lifecycle reset never ran: the gate stayed open
      // holding the dead page's in-flight accounting. The reloaded page's fresh
      // dispatcher now sends its one-shot handshake. Receiving it while the gate is
      // already open is proof a reset was missed, so it must reconcile — clear the
      // stale accounting and count the reset — before re-opening. Without that
      // reconcile the survivors stay pinned at the cap forever (this turns red).
      mainWindow.webContents.send.mockClear()
      handleRendererDispatcherReady()
      const reconciled = getPtyRendererDeliveryDebugSnapshot()
      expect(reconciled).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: 0,
        pendingPtyCount: 0,
        rendererLifecycleResetCount: 1,
        rendererPtyDispatcherReady: true
      })
      expect(reconciled.lastLifecycleResetClearedChars).toBeGreaterThan(0)

      // Delivery has resumed: fresh output flows immediately instead of piling up
      // behind the stale cap.
      mockProc.emitData('post-reconcile output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-reconcile output'
      })

      // A straggler ACK from the dead page is clamped and cannot underflow the
      // reconciled counters below zero.
      ackData(null, { id: spawnResult.id, charCount: 512 * 1024 })
      expect(getPtyRendererDeliveryDebugSnapshot().rendererInFlightChars).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds interactive input echo during the boot window until the dispatcher-ready handshake', async () => {
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
      const handleRendererLoading = getMainWindowWebContentsListener('did-start-loading')
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      const writeListener = getPtyWriteListener()
      // Drain the initial ready-flush the beforeEach handshake schedules.
      vi.advanceTimersByTime(1)

      // Reload closes the gate; the reloaded page's dispatcher has not re-registered.
      handleRendererLoading()
      mainWindow.webContents.send.mockClear()

      // Prime the interactive window with a keystroke, then emit a small redraw:
      // shouldSendInteractiveOutputNow() is true here, so ONLY the
      // `&& rendererPtyDispatcherReady` guard on the interactive fast path keeps this
      // echo from being sent into the still-listener-less page (removing that flag
      // check turns this red). It must accrue in pending, unsent and NOT in-flight.
      const redraw = '\x1b[20;2Hredraw'
      writeListener(mainWindowIpcEvent, { id: spawnResult.id, data: 'a' })
      mockProc.emitData(redraw)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: redraw.length,
        pendingPtyCount: 1
      })

      // The handshake releases the held echo (drained via the batch flush).
      handleRendererDispatcherReady()
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: redraw
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('force-opens the delivery gate if no dispatcher-ready handshake arrives after a reload', async () => {
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
      const handleRendererLoading = getMainWindowWebContentsListener('did-start-loading')
      vi.advanceTimersByTime(1)

      // Reload closes the gate and arms the ~10s watchdog; the reloaded page never
      // sends the handshake (dropped IPC), so output stays held in pending.
      handleRendererLoading()
      mainWindow.webContents.send.mockClear()
      mockProc.emitData('post-reload output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: false,
        rendererDispatcherReadyForcedCount: 0
      })

      // Past the watchdog window (10s) the gate self-heals: ready is forced, the
      // counter increments, and the held backlog drains — degrading to pre-handshake
      // behavior instead of a permanent freeze.
      vi.advanceTimersByTime(10_000)
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-reload output'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: true,
        rendererDispatcherReadyForcedCount: 1
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a dispatcher-ready handshake from a sender other than the main window', async () => {
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
      const handleRendererLoading = getMainWindowWebContentsListener('did-start-loading')
      const readyCall = onMock.mock.calls.find(
        (call: unknown[]) => call[0] === 'pty:rendererDispatcherReady'
      )!
      const rawReadyListener = readyCall[1] as (event: unknown) => void
      vi.advanceTimersByTime(1)

      // Why: a straggler handshake from a dying window's webContents must not
      // reopen the gate (or trigger the destructive reconcile) for the new page.
      handleRendererLoading()
      mainWindow.webContents.send.mockClear()
      rawReadyListener({ sender: { isDestroyed: () => false } })
      mockProc.emitData('post-reload output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: false
      })

      // The genuine main-window handshake still opens the gate and drains.
      rawReadyListener({ sender: mainWindow.webContents })
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-reload output'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: true
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the dispatcher-ready watchdog when the handshake arrives in time', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, cwd: '/tmp' })
      const handleRendererLoading = getMainWindowWebContentsListener('did-start-loading')
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      vi.advanceTimersByTime(1)

      // Reload arms the watchdog; a timely handshake must cancel it so no orphaned
      // ~10s timer lingers. Draining the handshake's empty flush must leave zero
      // pending timers — a surviving watchdog would show up here (the forced-count
      // guard alone can't catch it, since the watchdog no-ops once ready is true).
      handleRendererLoading()
      handleRendererDispatcherReady()
      vi.advanceTimersByTime(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: true,
        rendererDispatcherReadyForcedCount: 0
      })

      // Advancing well past the watchdog window leaves the forced counter at zero.
      vi.advanceTimersByTime(20_000)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: true,
        rendererDispatcherReadyForcedCount: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels a prior registration's armed dispatcher-ready watchdog when handlers re-register (no orphaned timer across window re-creation)", async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, cwd: '/tmp' })
      const handleRendererLoading = getMainWindowWebContentsListener('did-start-loading')
      // Drain the initial dispatcher-ready flush; the baseline is timer-free.
      vi.advanceTimersByTime(1)
      expect(vi.getTimerCount()).toBe(0)

      // A reload closes the gate and arms the ~10s self-heal watchdog on THIS
      // registration's closure.
      handleRendererLoading()
      expect(vi.getTimerCount()).toBe(1)

      // Re-registering handlers (macOS re-activate / new window owns delivery) must
      // cancel that armed watchdog via the cross-registration bridge at the top of
      // registerPtyHandlers — otherwise the prior closure's timer survives and later
      // force-opens a dead window's gate. The re-registration's own dispatcher-ready
      // handshake schedules and drains one 0ms flush; nothing else may remain.
      registerPtyHandlers(mainWindow as never)
      expect(vi.getTimerCount()).toBe(0)

      // And no orphaned ~10s watchdog fires later (removing the bridge cancel turns
      // this red: the prior closure's timer would still be pending here).
      vi.advanceTimersByTime(20_000)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves background-origin metadata for repaint output caused by a hidden resize', async () => {
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
      const setRendererPtyVisible = getPtySetRendererPtyVisibleListener()
      const resizePty = getPtyResizeListener()
      mainWindow.webContents.send.mockClear()

      setRendererPtyVisible(null, { id: spawnResult.id, visible: false })
      resizePty(null, { id: spawnResult.id, cols: 72, rows: 24 })
      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      mockProc.emitData('\x1b[2Khidden-resize redraw')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: '\x1b[2Khidden-resize redraw',
        background: true
      })

      mainWindow.webContents.send.mockClear()
      resizePty(null, { id: spawnResult.id, cols: 80, rows: 24 })
      mockProc.emitData('visible repaint')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'visible repaint'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not keep hidden resize metadata after visible user input', async () => {
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
      const setRendererPtyVisible = getPtySetRendererPtyVisibleListener()
      const resizePty = getPtyResizeListener()
      const writePty = getPtyWriteListener()
      mainWindow.webContents.send.mockClear()

      setRendererPtyVisible(null, { id: spawnResult.id, visible: false })
      resizePty(null, { id: spawnResult.id, cols: 72, rows: 24 })
      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      writePty(mainWindowIpcEvent, { id: spawnResult.id, data: 'x' })
      mockProc.emitData('x')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'x'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers agent startup OSC color queries before renderer batching', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        launchAgent: 'codex',
        terminalColorQueryReplies: {
          foreground: '#eeeeee',
          background: '#111111'
        }
      })) as { id: string }
      mockProc.proc.write.mockClear()
      mainWindow.webContents.send.mockClear()

      mockProc.emitData('\x1b]10;?\x1b\\\x1b]11;?\x1b\\ready')

      expect(mockProc.proc.write).toHaveBeenCalledWith('\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
      expect(mockProc.proc.write).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'ready'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers combined agent startup OSC foreground and background color queries', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        launchAgent: 'codex',
        terminalColorQueryReplies: {
          foreground: '#eeeeee',
          background: '#111111'
        }
      })) as { id: string }
      mockProc.proc.write.mockClear()
      mainWindow.webContents.send.mockClear()

      mockProc.emitData('\x1b]10;?;?\x1b\\ready')

      expect(mockProc.proc.write).toHaveBeenCalledWith('\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
      expect(mockProc.proc.write).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'ready'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not answer ordinary terminal OSC color queries in main', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        terminalColorQueryReplies: {
          foreground: '#eeeeee',
          background: '#111111'
        }
      })) as { id: string }
      mainWindow.webContents.send.mockClear()

      const query = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\'
      mockProc.emitData(`${query}ready`)

      expect(mockProc.proc.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: `${query}ready`
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not answer agent OSC color commands that only start like startup queries', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        launchAgent: 'codex',
        terminalColorQueryReplies: {
          foreground: '#eeeeee',
          background: '#111111'
        }
      })) as { id: string }
      mockProc.proc.write.mockClear()
      mainWindow.webContents.send.mockClear()

      const command = '\x1b]10;?not-a-query\x1b\\'
      mockProc.emitData(`${command}ready`)

      expect(mockProc.proc.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: `${command}ready`
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers daemon agent startup OSC color queries before spawn resolves', async () => {
    vi.useFakeTimers()
    let dataHandler: ((payload: { id: string; data: string }) => void) | null = null
    const write = vi.fn()
    const spawn = vi.fn(async (options: { sessionId?: string }) => {
      const id = options.sessionId ?? 'daemon-pty'
      dataHandler?.({ id, data: '\x1b]10;?\x1b\\\x1b]11;?\x1b\\daemon-ready' })
      return { id }
    })
    setLocalPtyProvider({
      spawn,
      write,
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
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        launchAgent: 'codex',
        terminalColorQueryReplies: {
          foreground: '#eeeeee',
          background: '#111111'
        }
      })) as { id: string }

      expect(write).toHaveBeenCalledWith(spawnResult.id, '\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
      expect(write).toHaveBeenCalledWith(spawnResult.id, '\x1b]11;rgb:1111/1111/1111\x1b\\')
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'daemon-ready'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops renderer sequence metadata when an answered OSC query is batched', async () => {
    vi.useFakeTimers()
    const providerEvents: {
      dataHandler?: (payload: { id: string; data: string }) => void
    } = {}
    const write = vi.fn()
    const spawn = vi.fn(async (options: { sessionId?: string }) => ({
      id: options.sessionId ?? 'daemon-pty'
    }))
    setLocalPtyProvider({
      spawn,
      write,
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
        providerEvents.dataHandler = handler
        return () => {}
      }),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    let seq = 0
    const runtime = {
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => null),
      onPtyData: vi.fn((_id: string, data: string) => {
        seq += data.length
        return seq
      }),
      registerPty: vi.fn()
    }

    try {
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        launchAgent: 'codex',
        terminalColorQueryReplies: {
          foreground: '#eeeeee',
          background: '#111111'
        }
      })) as { id: string }
      mainWindow.webContents.send.mockClear()

      providerEvents.dataHandler?.({ id: spawnResult.id, data: 'prefix' })
      providerEvents.dataHandler?.({
        id: spawnResult.id,
        data: '\x1b]10;?\x1b\\\x1b]11;?\x1b\\ready'
      })
      vi.advanceTimersByTime(2)

      expect(write).toHaveBeenCalledWith(spawnResult.id, '\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
      expect(write).toHaveBeenCalledWith(spawnResult.id, '\x1b]11;rgb:1111/1111/1111\x1b\\')
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'prefixready'
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

      writeListener(mainWindowIpcEvent, {
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
      vi.advanceTimersByTime(2)
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

      writeListener(mainWindowIpcEvent, {
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

      writeListener(mainWindowIpcEvent, {
        id: spawnResult.id,
        data: 'a'
      })
      mainWindow.webContents.send.mockClear()

      const largeOutput = 'x'.repeat(1025)
      mockProc.emitData(largeOutput)

      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
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

      writeListener(mainWindowIpcEvent, {
        id: spawnResult.id,
        data: 'a'
      })
      mainWindow.webContents.send.mockClear()

      const smallChunk = 'x'.repeat(512)
      for (let index = 0; index < 65; index++) {
        mockProc.emitData(smallChunk)
      }

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(64)
      vi.advanceTimersByTime(2)
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

      writeListener(mainWindowIpcEvent, {
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
      vi.advanceTimersByTime(2)
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

      writeListener(mainWindowIpcEvent, {
        id: spawnResult.id,
        data: 'a'
      })
      mockProc.emitData('redraw')

      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
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

      vi.advanceTimersByTime(2)

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
      vi.advanceTimersByTime(2)
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
      vi.advanceTimersByTime(2)

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

  it('caps per-PTY pending output while the renderer is starved and heals via a droppedOutput sentinel', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const ackData = getPtyAckDataListener()
      mainWindow.webContents.send.mockClear()

      // Saturate the renderer in-flight window (512 KB) with no ACKs — the
      // frozen/starved-renderer shape from the field reports.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 32; index++) {
        vi.advanceTimersByTime(1)
      }

      // Keep flooding well past the 2 MB per-PTY pending cap. Main must not
      // buffer this unboundedly (previously: unbounded string concat).
      mockProc.emitData('y'.repeat(3 * 1024 * 1024))
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 0
      })

      // Later output while dropped must stay O(1), not start re-accumulating.
      mockProc.emitData('z'.repeat(64 * 1024))
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 0
      })

      // Renderer recovers and ACKs: the flush must deliver the droppedOutput
      // sentinel so the pane repaints from the main-owned snapshot.
      mainWindow.webContents.send.mockClear()
      ackData(null, { id: spawn.id, charCount: 512 * 1024 })
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawn.id,
        data: '',
        droppedOutput: true
      })

      // Fresh output after the sentinel flows normally again.
      mainWindow.webContents.send.mockClear()
      mockProc.emitData('back to normal')
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawn.id,
        data: 'back to normal'
      })
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('carves reply-eliciting queries out of a pending-cap bulk drop so probes survive', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const ackData = getPtyAckDataListener()
      mainWindow.webContents.send.mockClear()

      // Saturate the in-flight window so everything after buffers in pendingData.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 32; index++) {
        vi.advanceTimersByTime(1)
      }

      // Flood past the pending cap WITH an embedded DSR probe — the program
      // that wrote it blocks on the reply (the bench DSR timeout).
      mockProc.emitData(`${'y'.repeat(2 * 1024 * 1024)}\x1b[6n${'y'.repeat(1024 * 1024)}`)
      // While latched, a later probe must also be carved out (bounded).
      mockProc.emitData(`${'z'.repeat(32 * 1024)}\x1b[0c${'z'.repeat(32 * 1024)}`)

      mainWindow.webContents.send.mockClear()
      ackData(null, { id: spawn.id, charCount: 512 * 1024 })
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawn.id,
        data: '\x1b[6n\x1b[0c',
        droppedOutput: true
      })
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('scales the pending-output cap with the scrollback setting', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      // 50k-row scrollback ⇒ 6 MB pending cap instead of the 2 MB floor.
      registerPtyHandlers(mainWindow as never, undefined, undefined, (() => ({
        terminalScrollbackRows: 50_000
      })) as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, cwd: '/tmp' })
      mainWindow.webContents.send.mockClear()

      // Saturate the in-flight window with no ACKs, then buffer 3 MB — over
      // the floor, under the scaled cap: it must be retained, not dropped.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 32; index++) {
        vi.advanceTimersByTime(1)
      }
      mockProc.emitData('y'.repeat(3 * 1024 * 1024))
      expect(getPtyRendererDeliveryDebugSnapshot().pendingChars).toBeGreaterThan(3 * 1024 * 1024)

      // The scaled cap still bounds a runaway flood.
      mockProc.emitData('z'.repeat(4 * 1024 * 1024))
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 0
      })
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('pauses the producer at the pending high watermark and resumes after drain', async () => {
    vi.useFakeTimers()
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      mainWindow.webContents.send.mockClear()

      // Flood in 64KB chunks like a `yes`-style producer that honors pause —
      // node-pty pause() stops the fd read, so a real producer stops emitting.
      const chunk = 'x'.repeat(64 * 1024)
      let chunks = 0
      while (provider.pauseProducer.mock.calls.length === 0 && chunks < 100) {
        provider.emitData('flood-pty', chunk)
        chunks++
      }

      // Pause fires exactly once, on the first chunk past the 256KB high
      // watermark (the 5th 64KB chunk), not once per chunk.
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)
      expect(provider.pauseProducer).toHaveBeenCalledWith('flood-pty')
      expect(chunks).toBe(5)
      // Bounded: main buffered at most HIGH + one chunk while paused.
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 320 * 1024,
        peakPendingChars: 320 * 1024
      })

      // Drain to the renderer. Resume must fire exactly once — when pending
      // drops below the 32KB low watermark — with no pause/resume flapping
      // while pending crosses the 32-256KB hysteresis band.
      vi.runAllTimers()
      expect(provider.resumeProducer).toHaveBeenCalledTimes(1)
      expect(provider.resumeProducer).toHaveBeenCalledWith('flood-pty')
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({ pendingChars: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes a paused producer when the PTY exits before draining', async () => {
    vi.useFakeTimers()
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      mainWindow.webContents.send.mockClear()

      provider.emitData('flood-pty', 'x'.repeat(320 * 1024))
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)

      // Exit while pending is still above the low watermark: the exit path
      // must release the pause instead of leaving a stale mark behind.
      provider.emitExit('flood-pty', 0)
      expect(provider.resumeProducer).toHaveBeenCalledTimes(1)
      expect(provider.resumeProducer).toHaveBeenCalledWith('flood-pty')
    } finally {
      vi.useRealTimers()
    }
  })

  const DELIVERY_RESYNC_UNANSWERED_WARNING =
    '[pty] delivery resync probe unanswered — renderer IPC unresponsive'

  function countResyncUnansweredWarnings(warnSpy: { mock: { calls: unknown[][] } }): number {
    return warnSpy.mock.calls.filter((call) => call[0] === DELIVERY_RESYNC_UNANSWERED_WARNING)
      .length
  }

  function getPtyDataSendCalls(): unknown[][] {
    return mainWindow.webContents.send.mock.calls.filter(
      (call: unknown[]) => call[0] === 'pty:data'
    )
  }

  function getDeliveryResyncProbeCalls(): unknown[][] {
    return mainWindow.webContents.send.mock.calls.filter(
      (call: unknown[]) => call[0] === 'pty:requestDeliveryResync'
    )
  }

  function getDeliveryResyncResponseListener(): (
    event: unknown,
    args: { requestId: number; processedCharsByPty: Record<string, number> }
  ) => void {
    const responseCall = onMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'pty:deliveryResyncResponse'
    )
    if (!responseCall) {
      throw new Error('missing pty:deliveryResyncResponse listener')
    }
    return responseCall[1] as (
      event: unknown,
      args: { requestId: number; processedCharsByPty: Record<string, number> }
    ) => void
  }

  /** Saturates one PTY to its 512 KiB in-flight cap so delivery is fully
   *  gated for that PTY. Leaves 88 KiB pending and no timers scheduled. */
  async function spawnAndSaturateRendererDeliveryGate(
    mockProc: ReturnType<typeof createMockProc>
  ): Promise<{ id: string }> {
    registerPtyHandlers(mainWindow as never)
    const spawnResult = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp'
    })) as { id: string }
    mainWindow.webContents.send.mockClear()
    mockProc.emitData('x'.repeat(600 * 1024))
    vi.advanceTimersByTime(8)
    for (let index = 0; index < 32; index++) {
      vi.advanceTimersByTime(1)
    }
    return spawnResult
  }

  it('self-heals lost ACKs when a later cumulative ACK arrives', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)
      expect(getPtyDataSendCalls()).toHaveLength(32)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        rendererInFlightPtyCount: 1
      })

      // Every per-chunk ACK was lost, but the next ACK carries the renderer's
      // full cumulative total — the debt clears without any timer or reset.
      const ackData = getPtyAckDataListener()
      ackData(null, { id: spawnResult.id, processedChars: 512 * 1024 })

      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        rendererInFlightPtyCount: 0
      })

      vi.runOnlyPendingTimers()
      expect(getPtyDataSendCalls()).toHaveLength(33)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies cumulative ACKs idempotently and ignores stale reordered totals', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)
      const ackData = getPtyAckDataListener()

      ackData(null, { id: spawnResult.id, processedChars: 256 * 1024 })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 256 * 1024,
        maxRendererInFlightCharsByPty: 256 * 1024
      })

      // Replayed duplicate credits nothing further.
      ackData(null, { id: spawnResult.id, processedChars: 256 * 1024 })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 256 * 1024
      })

      // A stale reordered total can never move accounting backwards.
      ackData(null, { id: spawnResult.id, processedChars: 128 * 1024 })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 256 * 1024
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('tolerates mixed legacy delta and cumulative ACK payloads', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)
      const ackData = getPtyAckDataListener()

      // Legacy delta shape (no processedChars) still credits per chunk.
      ackData(null, { id: spawnResult.id, charCount: 16 * 1024 })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 496 * 1024
      })

      // A cumulative total then supersedes without double-crediting the delta.
      ackData(null, { id: spawnResult.id, processedChars: 512 * 1024 })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        rendererInFlightPtyCount: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards only newly acknowledged cumulative bytes to provider ACK backpressure', async () => {
    vi.useFakeTimers()
    const acknowledgeDataEvent = vi.fn()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      setLocalPtyProvider({
        spawn: vi.fn(async () => ({ id: 'cumulative-pty' })),
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
          mockProc.proc.onData((data: string) => callback({ id: 'cumulative-pty', data }))
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

      // Why: cumulative totals are clamped to what main actually sent, and a
      // replayed total must credit SSH/relay flow control with zero, not
      // duplicate bytes.
      ackData(null, { id: 'cumulative-pty', processedChars: 1024 })
      ackData(null, { id: 'cumulative-pty', processedChars: 1024 })

      expect(acknowledgeDataEvent).toHaveBeenNthCalledWith(
        1,
        'cumulative-pty',
        'remote-output'.length
      )
      expect(acknowledgeDataEvent).toHaveBeenNthCalledWith(2, 'cumulative-pty', 0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('probes for a delivery resync when data arrives for a fully gated PTY and reconciles on reply', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)

      mockProc.emitData('stuck-output')
      expect(getDeliveryResyncProbeCalls()).toHaveLength(1)
      const probePayload = getDeliveryResyncProbeCalls()[0]![1] as { requestId: number }

      // Only one probe may be outstanding at a time.
      mockProc.emitData('still-stuck')
      expect(getDeliveryResyncProbeCalls()).toHaveLength(1)

      const respondDeliveryResync = getDeliveryResyncResponseListener()
      respondDeliveryResync(null, {
        requestId: probePayload.requestId,
        processedCharsByPty: { [spawnResult.id]: 512 * 1024 }
      })

      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        rendererInFlightPtyCount: 0
      })

      // The reconciled gate lets the held pendingData flush again (one 2ms
      // batch window = one 16KB slice).
      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls()).toHaveLength(33)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores resync replies with stale request ids', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)
      mockProc.emitData('stuck-output')
      const probePayload = getDeliveryResyncProbeCalls()[0]![1] as { requestId: number }

      const respondDeliveryResync = getDeliveryResyncResponseListener()
      respondDeliveryResync(null, {
        requestId: probePayload.requestId + 41,
        processedCharsByPty: { [spawnResult.id]: 512 * 1024 }
      })

      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears an unanswered resync probe, warns once per silent streak, and never mutates counters', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      await spawnAndSaturateRendererDeliveryGate(mockProc)

      mockProc.emitData('stuck-output')
      expect(getDeliveryResyncProbeCalls()).toHaveLength(1)

      vi.advanceTimersByTime(4_999)
      expect(countResyncUnansweredWarnings(warnSpy)).toBe(0)

      vi.advanceTimersByTime(1)
      expect(countResyncUnansweredWarnings(warnSpy)).toBe(1)
      expect(warnSpy).toHaveBeenCalledWith(
        DELIVERY_RESYNC_UNANSWERED_WARNING,
        expect.objectContaining({
          rendererInFlightChars: 512 * 1024,
          pendingPtyCount: 1
        })
      )
      // No blind reset: counters and pending output are untouched.
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        pendingChars: 88 * 1024 + 'stuck-output'.length
      })
      expect(getPtyDataSendCalls()).toHaveLength(32)

      // The cleared flag lets the next gated arrival probe again, but a
      // still-silent renderer does not spam a second warn.
      mockProc.emitData('still-stuck')
      expect(getDeliveryResyncProbeCalls()).toHaveLength(2)
      vi.advanceTimersByTime(5_000)
      expect(countResyncUnansweredWarnings(warnSpy)).toBe(1)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024
      })
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('clears resync probe state when the window is destroyed', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    let destroyed = false
    const destroyableWindow = {
      isDestroyed: () => destroyed,
      isFocused: () => true,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { on: vi.fn(), send: vi.fn(), removeListener: vi.fn() }
    }

    try {
      registerPtyHandlers(destroyableWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, cwd: '/tmp' })
      destroyableWindow.webContents.send.mockClear()
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 32; index++) {
        vi.advanceTimersByTime(1)
      }
      mockProc.emitData('stuck-output')
      // The outstanding probe's hygiene timeout is the only remaining timer;
      // the dispatcher-ready handshake already drained the pending flush.
      expect(vi.getTimerCount()).toBe(1)

      destroyed = true
      mockProc.emitData('post-destroy output')

      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(60_000)
      expect(countResyncUnansweredWarnings(warnSpy)).toBe(0)
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  // ── Renderer-initiated delivery health/heal (pty:reportRendererDeliveryState) ──
  // Field wedge repro (v1.4.121-rc.0 snapshot): push delivery dead, invoke
  // alive. The solicited-resync probe above rides push and can never be
  // answered in that state; this invoke lane is the recovery that can.

  function reportRendererDeliveryState(args: {
    receivedCharsByPty: Record<string, number>
    processedCharsByPty: Record<string, number>
    heal?: boolean
    rendererPtyDataListenerCount?: number | null
  }): {
    inFlightTotalChars: number
    inFlightPtyCount: number
    msSinceLastAck: number | null
    writtenOff?: { id: string; markerSeq?: number; writtenOffChars: number }[]
  } {
    const handler = handlers.get('pty:reportRendererDeliveryState')
    if (!handler) {
      throw new Error('missing pty:reportRendererDeliveryState handler')
    }
    return handler(null, args) as ReturnType<typeof reportRendererDeliveryState>
  }

  it('reports delivery health over invoke without mutating any delivery state', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      await spawnAndSaturateRendererDeliveryGate(mockProc)

      // The field wedge in miniature: renderer received nothing, no ACK ever.
      const health = reportRendererDeliveryState({
        receivedCharsByPty: {},
        processedCharsByPty: {}
      })

      expect(health).toMatchObject({
        inFlightTotalChars: 512 * 1024,
        inFlightPtyCount: 1,
        msSinceLastAck: null
      })
      expect(health.writtenOff).toBeUndefined()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        pendingChars: 88 * 1024
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('merges cumulative processed totals from a health report as a repair lane', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)

      // Lost-ACK variant: renderer processed everything; only the ACK
      // messages vanished. A plain report (no heal) must drain the debt.
      const health = reportRendererDeliveryState({
        receivedCharsByPty: { [spawnResult.id]: 512 * 1024 },
        processedCharsByPty: { [spawnResult.id]: 512 * 1024 }
      })

      expect(health).toMatchObject({ inFlightTotalChars: 0, inFlightPtyCount: 0 })
      expect(health.writtenOff).toBeUndefined()
      // Fully reopened gate drains one 16K slice per batcher tick (0/1/2 ms).
      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls()).toHaveLength(35)
    } finally {
      vi.useRealTimers()
    }
  })

  it('heals a dead push channel: writes off unreceived bytes and returns restore markers', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)

      const healed = reportRendererDeliveryState({
        receivedCharsByPty: {},
        processedCharsByPty: {},
        heal: true,
        rendererPtyDataListenerCount: 1
      })

      // The 512 KiB the renderer provably never received is written off; the
      // 88 KiB still pending is dropped because the snapshot restore covers
      // everything at or before the marker (hidden-drop parity).
      expect(healed.writtenOff).toEqual([{ id: spawnResult.id, writtenOffChars: 512 * 1024 }])
      expect(healed).toMatchObject({ inFlightTotalChars: 0, inFlightPtyCount: 0 })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: 0,
        pendingDroppedChars: 88 * 1024
      })
      expect(warnSpy).toHaveBeenCalledWith(
        '[pty] delivery heal: wrote off renderer-bound bytes lost in push channel',
        expect.objectContaining({ rendererPtyDataListenerCount: 1 })
      )

      // Delivery is unwedged: fresh output flows to the renderer again.
      mockProc.emitData('after-heal')
      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls()).toHaveLength(33)
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('never writes off bytes the renderer received but has not parsed yet', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)

      // Parse backpressure, not a wedge: every byte arrived, ACK credit is
      // deferred to the scheduler consume point and will still repay this.
      const health = reportRendererDeliveryState({
        receivedCharsByPty: { [spawnResult.id]: 512 * 1024 },
        processedCharsByPty: {},
        heal: true,
        rendererPtyDataListenerCount: 1
      })

      expect(health.writtenOff).toBeUndefined()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        pendingChars: 88 * 1024
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a heal while main has seen a recent ACK', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)
      const ackData = getPtyAckDataListener()
      ackData(null, { id: spawnResult.id, processedChars: 16 * 1024 })

      // Some pty still round-trips ACKs — whatever the renderer thinks, the
      // channel is not dead, so a heal request must not destroy accounting.
      const blocked = reportRendererDeliveryState({
        receivedCharsByPty: {},
        processedCharsByPty: {},
        heal: true
      })
      expect(blocked.writtenOff).toBeUndefined()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 496 * 1024
      })

      // Once main-side ACK silence crosses the floor, the same heal proceeds.
      // (The ACK freed a 16K window slot, so one more pending slice shipped
      // during the advance — the write-off covers 512K un-received again.)
      vi.advanceTimersByTime(10_000)
      const healed = reportRendererDeliveryState({
        receivedCharsByPty: {},
        processedCharsByPty: {},
        heal: true
      })
      expect(healed.writtenOff).toEqual([{ id: spawnResult.id, writtenOffChars: 512 * 1024 }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('zeroes renderer in-flight delivery counters when the renderer lifecycle resets', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      await spawnAndSaturateRendererDeliveryGate(mockProc)
      const handleRendererLoading = getMainWindowWebContentsListener('did-start-loading')
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightPtyCount: 1,
        rendererInFlightChars: 512 * 1024
      })

      handleRendererLoading()

      // Why: reload kills the renderer dispatcher that would have ACKed, so
      // keeping the counters would gate PTYs in the fresh renderer forever.
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0
      })
      // Main now holds sends until the replacement page confirms its dispatcher
      // is installed; the lifecycle reset arms a bounded handshake watchdog.
      expect(vi.getTimerCount()).toBe(1)

      mockProc.emitData('after-reload')
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)

      getPtyRendererDispatcherReadyListener()()
      // One 2ms batch window releases the fresh page's held output.
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(33)
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
      vi.advanceTimersByTime(2)

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
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(512)
      expect(vi.getTimerCount()).toBe(0)

      writeListener(mainWindowIpcEvent, {
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
        writeListener(mainWindowIpcEvent, {
          id: interactiveSpawn.id,
          data: 'a'
        })
        interactiveProc.emitData(reserveChunk)
      }
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(529)

      writeListener(mainWindowIpcEvent, {
        id: interactiveSpawn.id,
        data: 'a'
      })
      interactiveProc.emitData(reserveChunk)
      // Why: the reserve-exhausted send stays gated, and the fully gated
      // arrival now also emits one delivery resync probe (not pty:data).
      expect(getPtyDataSendCalls()).toHaveLength(529)
      expect(getDeliveryResyncProbeCalls()).toHaveLength(1)
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
      vi.advanceTimersByTime(2)
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
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(512)

      const activeIndex = procs.length - 1
      procs[activeIndex]!.emitData('active-output')
      setActiveRendererPty(null, { id: spawns[activeIndex]!.id, active: true })
      vi.advanceTimersByTime(2)

      // Why: the fully gated arrival also emits one delivery resync probe, so
      // count pty:data sends rather than raw webContents.send calls.
      expect(getPtyDataSendCalls()).toHaveLength(513)
      expect(getPtyDataSendCalls()[512]).toEqual([
        'pty:data',
        {
          id: spawns[activeIndex]!.id,
          data: 'active-output'
        }
      ])
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
      vi.advanceTimersByTime(2)
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

  describe('hidden renderer delivery gate', () => {
    it('drops hidden PTY data after model ingestion and emits one out-of-band restore marker', async () => {
      vi.useFakeTimers()
      const runtime = {
        setPtyController: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(() => 42),
        getPtyOutputSequence: vi.fn(() => 42),
        hasRemoteTerminalViewSubscriber: vi.fn(() => false),
        createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-1'),
        registerPreAllocatedHandleForPty: vi.fn()
      }
      const daemon = installObservableDaemonTestProvider()
      try {
        registerPtyHandlers(mainWindow as never, runtime as never)
        const result = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: result.id, hidden: true })
        daemon.emitData(result.id, 'hidden output')
        vi.advanceTimersByTime(50)

        // Model ingestion still ran — only renderer delivery was dropped.
        expect(runtime.onPtyData).toHaveBeenCalledWith(
          result.id,
          'hidden output',
          expect.any(Number),
          'hidden output'.length
        )
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        // Why out-of-band: an in-band empty pty:data chunk is ambiguous with
        // chunks fully consumed by renderer OSC-9999 stripping.
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: result.id,
          reason: 'hidden-drop',
          markerSeq: 42
        })

        // Subsequent gated chunks drop silently — the marker is one-shot.
        daemon.emitData(result.id, 'more hidden output')
        vi.advanceTimersByTime(50)
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          hiddenDeliveryGatedPtyCount: 1,
          hiddenDeliveryGatedVisiblePtyCount: 0,
          hiddenDeliveryGatedActivePtyCount: 0,
          hiddenDeliveryDroppedChars: 'hidden output'.length + 'more hidden output'.length,
          hiddenDeliveryDroppedChunks: 2,
          pendingPtyCount: 0,
          rendererInFlightChars: 0
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('surfaces the hidden-yet-visible contradiction in the snapshot and warns on drop', async () => {
      // Why: v1.4.124-rc.2.perf field snapshot — blank terminal with 2 ptys
      // hidden-gated and 78MB dropped. The aggregate counts could not say
      // whether the pane the user was staring at was one of them; this
      // overlap counter + warn makes the next occurrence decisive.
      vi.useFakeTimers()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const daemon = installObservableDaemonTestProvider()
      try {
        registerPtyHandlers(mainWindow as never)
        const result = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        const setVisible = getPtySetRendererPtyVisibleListener()

        // The two renderer visibility signals contradict: the pane reports
        // itself visible while the hidden-delivery gate still holds it.
        setVisible(null, { id: result.id, visible: true })
        setHidden(null, { id: result.id, hidden: true })
        daemon.emitData(result.id, 'starved visible output')
        vi.advanceTimersByTime(50)

        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          hiddenDeliveryGatedPtyCount: 1,
          hiddenDeliveryGatedVisiblePtyCount: 1,
          hiddenDeliveryDroppedChars: 'starved visible output'.length
        })
        expect(warnSpy).toHaveBeenCalledWith(
          '[pty] hidden-delivery gate is dropping bytes for a visible/active pty',
          expect.objectContaining({ id: result.id, visible: true })
        )

        // Unhiding resolves the contradiction.
        setHidden(null, { id: result.id, hidden: false })
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          hiddenDeliveryGatedPtyCount: 0,
          hiddenDeliveryGatedVisiblePtyCount: 0
        })
      } finally {
        warnSpy.mockRestore()
        vi.useRealTimers()
      }
    })

    it('embeds one-paste freeze diagnostics: per-pty table and breadcrumb history', async () => {
      vi.useFakeTimers()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const daemon = installObservableDaemonTestProvider()
      try {
        registerPtyHandlers(mainWindow as never)
        const result = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        const setVisible = getPtySetRendererPtyVisibleListener()
        setVisible(null, { id: result.id, visible: true })
        setHidden(null, { id: result.id, hidden: true })
        daemon.emitData(result.id, 'starved visible output')
        vi.advanceTimersByTime(50)

        const { diagnostics } = getPtyRendererDeliveryDebugSnapshot()
        expect(diagnostics.appVersion).toBe('0.0.0-test')
        expect(diagnostics.windowFocused).toBe(true)
        expect(diagnostics.windowVisible).toBe(true)
        const entry = diagnostics.perPty.find(
          (candidate) => candidate.id === redactPtyIdForDiagnostics(result.id)
        )
        expect(entry).toMatchObject({
          hidden: true,
          visible: true,
          inFlightChars: 0,
          pendingChars: 0
        })
        // Why redaction is pinned here: daemon session ids embed worktree
        // paths; the report must never carry the raw id.
        expect(diagnostics.perPty.some((candidate) => candidate.id === result.id)).toBe(false)
        const breadcrumbKinds = diagnostics.breadcrumbs.map((crumb) => crumb.kind)
        expect(breadcrumbKinds).toContain('gate-mark')
        expect(breadcrumbKinds).toContain('hidden-drop-visible')
      } finally {
        warnSpy.mockRestore()
        vi.useRealTimers()
      }
    })

    it('keeps the interactive bypass gated for hidden PTYs', async () => {
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
        const setHidden = getPtySetHiddenRendererPtyListener()

        writeListener(mainWindowIpcEvent, { id: spawnResult.id, data: 'a' })
        setHidden(null, { id: spawnResult.id, hidden: true })
        mainWindow.webContents.send.mockClear()

        // A keystroke-sized redraw would take the immediate path when visible.
        mockProc.emitData('\x1b[20;2Hredraw')
        vi.advanceTimersByTime(2)

        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'hidden-drop'
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('suppresses the gate while renderer delivery interest is registered', async () => {
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
        const setHidden = getPtySetHiddenRendererPtyListener()
        const setInterest = getPtySetDeliveryInterestListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: spawnResult.id, hidden: true })
        setInterest(null, { id: spawnResult.id, interested: true })
        mockProc.emitData('sidecar bytes')
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
          id: spawnResult.id,
          data: 'sidecar bytes'
        })

        setInterest(null, { id: spawnResult.id, interested: false })
        mainWindow.webContents.send.mockClear()
        mockProc.emitData('gated bytes')
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'hidden-drop'
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it.each([
      ['terminalHiddenDeliveryGate', { terminalHiddenDeliveryGate: false }],
      ['terminalMainSideEffectAuthority', { terminalMainSideEffectAuthority: false }]
    ])('keeps delivery when the %s kill switch is off', async (_name, settings) => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never, undefined, undefined, (() => settings) as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: spawnResult.id, hidden: true })
        mockProc.emitData('still delivered')
        vi.advanceTimersByTime(2)

        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
          id: spawnResult.id,
          data: 'still delivered'
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('drops queued pending data when a PTY is marked hidden', async () => {
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
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        mockProc.emitData('queued before hidden')
        expect(mainWindow.webContents.send).not.toHaveBeenCalled()
        setHidden(null, { id: spawnResult.id, hidden: true })

        // The queued bytes are model-owned; only the restore marker goes out.
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'hidden-drop'
        })
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({ pendingPtyCount: 0 })
      } finally {
        vi.useRealTimers()
      }
    })

    it('re-emits the restore marker on unhide and resumes delivery', async () => {
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
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: spawnResult.id, hidden: true })
        mockProc.emitData('dropped while hidden')
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)

        // Why: a renderer reload can replace the view that latched
        // restore-needed; unhide repeats the marker so the live view heals.
        setHidden(null, { id: spawnResult.id, hidden: false })
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(2)
        expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'unhide'
        })

        mockProc.emitData('visible again')
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:data', {
          id: spawnResult.id,
          data: 'visible again'
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not emit an unhide marker when nothing was dropped', async () => {
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
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: spawnResult.id, hidden: true })
        setHidden(null, { id: spawnResult.id, hidden: false })

        expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('clears gate state on PTY exit', async () => {
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
        const setHidden = getPtySetHiddenRendererPtyListener()

        setHidden(null, { id: spawnResult.id, hidden: true })
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          hiddenDeliveryGatedPtyCount: 1
        })

        mockProc.emitExit(0)
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          hiddenDeliveryGatedPtyCount: 0,
          deliveryInterestPtyCount: 0
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps drop memory across a hidden remount so reveal still restores', async () => {
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
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: spawnResult.id, hidden: true })
        mockProc.emitData('dropped while hidden')
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)

        // Why: a hidden remount (tab move, parking handoff) re-marks the PTY
        // without an unhide in between. The fresh view never saw the first
        // marker, so re-marking must NOT erase the drop memory.
        setHidden(null, { id: spawnResult.id, hidden: true })
        setHidden(null, { id: spawnResult.id, hidden: false })

        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(2)
        expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'unhide'
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps drop memory across a renderer reload while clearing hidden/interest state', async () => {
      vi.useFakeTimers()
      const runtime = {
        setPtyController: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(() => 42),
        getPtyOutputSequence: vi.fn(() => 42),
        hasRemoteTerminalViewSubscriber: vi.fn(() => false),
        createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-1'),
        registerPreAllocatedHandleForPty: vi.fn()
      }
      const daemon = installObservableDaemonTestProvider()
      try {
        registerPtyHandlers(mainWindow as never, runtime as never)
        // Why daemon provider: it survives renderer reloads (the scenario
        // under test) and keeps the LocalPtyProvider orphan-kill handler off
        // this webContents, so 'did-finish-load' maps to the gate reset only.
        const reloadHandlers = mainWindow.webContents.on.mock.calls
          .filter((call: unknown[]) => call[0] === 'did-finish-load')
          .map((call: unknown[]) => call[1] as () => void)
        expect(reloadHandlers).toHaveLength(1)
        const result = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: result.id, hidden: true })
        daemon.emitData(result.id, 'dropped while hidden')
        vi.advanceTimersByTime(50)
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)

        // Renderer reload: hidden marks die with the old renderer, but the
        // dropped bytes were never restored — memory must survive.
        reloadHandlers[0]()
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          hiddenDeliveryGatedPtyCount: 0
        })

        // The reloaded pane's first sync re-marks hidden, then reveals.
        setHidden(null, { id: result.id, hidden: true })
        setHidden(null, { id: result.id, hidden: false })
        expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:modelRestoreNeeded', {
          id: result.id,
          reason: 'unhide',
          markerSeq: 42
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('clears leaked delivery interest on renderer reload so the gate re-engages', async () => {
      vi.useFakeTimers()
      const runtime = {
        setPtyController: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(() => 42),
        getPtyOutputSequence: vi.fn(() => 42),
        hasRemoteTerminalViewSubscriber: vi.fn(() => false),
        createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-1'),
        registerPreAllocatedHandleForPty: vi.fn()
      }
      const daemon = installObservableDaemonTestProvider()
      try {
        registerPtyHandlers(mainWindow as never, runtime as never)
        const reloadHandlers = mainWindow.webContents.on.mock.calls
          .filter((call: unknown[]) => call[0] === 'did-finish-load')
          .map((call: unknown[]) => call[1] as () => void)
        expect(reloadHandlers).toHaveLength(1)
        const result = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session'
        })) as { id: string }
        const setHidden = getPtySetHiddenRendererPtyListener()
        const setInterest = getPtySetDeliveryInterestListener()
        mainWindow.webContents.send.mockClear()

        // A sidecar holds interest, so hidden bytes still flow.
        setInterest(null, { id: result.id, interested: true })
        setHidden(null, { id: result.id, hidden: true })
        daemon.emitData(result.id, 'sidecar bytes')
        vi.advanceTimersByTime(50)
        expect(mainWindow.webContents.send).toHaveBeenLastCalledWith(
          'pty:data',
          expect.objectContaining({ id: result.id, data: 'sidecar bytes' })
        )

        // Why: the renderer reload killed the sidecar's ref count without a
        // release IPC — the leaked hold must not force-feed the PTY forever.
        reloadHandlers[0]()
        mainWindow.webContents.send.mockClear()
        setHidden(null, { id: result.id, hidden: true })
        daemon.emitData(result.id, 'gated after reload')
        vi.advanceTimersByTime(50)

        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: result.id,
          reason: 'hidden-drop',
          markerSeq: 42
        })
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('hidden-at-spawn mark (initiallyHidden)', () => {
    // terminal-query-authority.md §races: the renderer declares hidden-at-
    // spawn so main marks the PTY before its first byte — the spawn-time
    // query window where neither side replied (the non-codex DA1 loss) is
    // closed by the gate + responder owning queries from byte one.
    function createRuntimeMock() {
      return {
        setPtyController: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(() => 42),
        getPtyOutputSequence: vi.fn(() => 42),
        hasRemoteTerminalViewSubscriber: vi.fn(() => false),
        createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-1'),
        registerPreAllocatedHandleForPty: vi.fn()
      }
    }

    it('marks a daemon PTY hidden before spawn resolves so byte zero is gated', async () => {
      vi.useFakeTimers()
      const runtime = createRuntimeMock()
      const daemon = installObservableDaemonTestProvider()
      const spawnGate = makeDeferred()
      daemon.spawn.mockImplementation(async (options: { sessionId?: string }) => {
        await spawnGate.promise
        return { id: options.sessionId ?? 'daemon-pty' }
      })
      try {
        registerPtyHandlers(mainWindow as never, runtime as never)
        const spawnPromise = handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session',
          initiallyHidden: true
        }) as Promise<{ id: string }>
        // Let the handler run up to the awaited provider.spawn.
        await Promise.resolve()
        mainWindow.webContents.send.mockClear()

        // Daemon PTYs can emit prompt bytes before spawn() resolves — the
        // pre-spawn mark must already gate them.
        expect(isHiddenRendererPty('daemon-session')).toBe(true)
        daemon.emitData('daemon-session', 'pre-spawn prompt\x1b[c')
        vi.advanceTimersByTime(50)
        expect(runtime.onPtyData).toHaveBeenCalledWith(
          'daemon-session',
          'pre-spawn prompt\x1b[c',
          expect.any(Number),
          'pre-spawn prompt\x1b[c'.length
        )
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: 'daemon-session',
          reason: 'hidden-drop',
          markerSeq: 42
        })

        spawnGate.resolve()
        const result = await spawnPromise
        expect(isHiddenRendererPty(result.id)).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('clears the pre-spawn hidden mark when the spawn fails', async () => {
      const daemon = installObservableDaemonTestProvider()
      daemon.spawn.mockRejectedValue(new Error('spawn exploded'))
      registerPtyHandlers(mainWindow as never)

      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session',
          initiallyHidden: true
        })
      ).rejects.toThrow('spawn exploded')

      // A later visible attach reusing this session id must not start gated.
      expect(isHiddenRendererPty('daemon-session')).toBe(false)
    })

    it('marks local PTYs hidden after spawn, before their first data task', async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)
      try {
        registerPtyHandlers(mainWindow as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp',
          initiallyHidden: true
        })) as { id: string }
        mainWindow.webContents.send.mockClear()

        expect(isHiddenRendererPty(spawnResult.id)).toBe(true)
        mockProc.emitData('first chunk')
        vi.advanceTimersByTime(2)

        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'hidden-drop'
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps spawns without the flag delivering to the renderer (visible unchanged)', async () => {
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

        expect(isHiddenRendererPty(spawnResult.id)).toBe(false)
        mockProc.emitData('visible output')
        vi.advanceTimersByTime(2)

        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
          id: spawnResult.id,
          data: 'visible output'
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('answers DA1 from the model on the first chunk of a hidden-at-spawn PTY', async () => {
      // End-to-end through a REAL runtime: spawn-marked → first chunk dropped
      // → runtime emulator parses the query → reply written to the provider
      // input path (the renderer never saw the bytes; main is the answerer).
      const daemon = installObservableDaemonTestProvider()
      const runtime = new OrcaRuntimeService({
        getRepo: () => undefined,
        getRepos: () => [],
        addRepo: () => {},
        updateRepo: () => undefined as never,
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        setWorktreeMeta: () => undefined as never,
        removeWorktreeMeta: () => {},
        getGitHubCache: () => ({ pr: {}, issue: {} }) as never,
        getSettings: () => ({
          workspaceDir: '/tmp/workspaces',
          nestWorkspaces: false,
          refreshLocalBaseRefOnWorktreeCreate: false,
          branchPrefix: 'none',
          branchPrefixCustom: '',
          terminalMainSideEffectAuthority: true,
          terminalHiddenDeliveryGate: true,
          terminalModelQueryAuthority: true
        })
      } as never)

      registerPtyHandlers(mainWindow as never, runtime as never)
      const result = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        sessionId: 'daemon-session',
        initiallyHidden: true
      })) as { id: string }

      daemon.emitData(result.id, '\x1b[c')
      // Settle the per-PTY emulator writeChain (and the reply it forwards).
      await runtime.serializeMainTerminalBuffer(result.id)

      expect(daemon.write).toHaveBeenCalledWith(result.id, '\x1b[?1;2c')
    })
  })

  it('caps pending renderer delivery per PTY with oldest-drop and one restore marker', async () => {
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

      // 3 MB in one starved pending entry: the scrollback-scaled cap (2 MB at
      // default settings) drops the buffered bytes to O(1) memory. One
      // out-of-band restore marker fires; the droppedOutput sentinel then
      // routes the pane through the main-owned snapshot repaint.
      mockProc.emitData('x'.repeat(1024 * 1024) + 'y'.repeat(2 * 1024 * 1024))

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
        id: spawnResult.id,
        reason: 'pending-cap'
      })

      // A second overflow before the entry drains must not re-mark.
      mockProc.emitData('z'.repeat(64 * 1024))
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(2)
      expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:data', {
        id: spawnResult.id,
        data: '',
        droppedOutput: true
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['terminalHiddenDeliveryGate', { terminalHiddenDeliveryGate: false }],
    ['terminalMainSideEffectAuthority', { terminalMainSideEffectAuthority: false }]
  ])(
    'keeps the pending cap active without a restore marker when the %s kill switch is off',
    async (_name, settings) => {
      // Why: the scrollback-scaled pending cap ships independently of the gate
      // (#7150) — the droppedOutput sentinel repaints the pane from the
      // main-owned snapshot even with the model/view kill switches off. Only the
      // gate's out-of-band pty:modelRestoreNeeded marker is switch-scoped.
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never, undefined, undefined, (() => settings) as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }
        mainWindow.webContents.send.mockClear()

        mockProc.emitData('x'.repeat(3 * 1024 * 1024))

        expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(
          'pty:modelRestoreNeeded',
          expect.anything()
        )

        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:data', {
          id: spawnResult.id,
          data: '',
          droppedOutput: true
        })
      } finally {
        vi.useRealTimers()
      }
    }
  )

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

      writeListener(mainWindowIpcEvent, {
        id: spawnResult.id,
        data: 'a'
      })
      vi.advanceTimersByTime(101)
      mainWindow.webContents.send.mockClear()

      mockProc.emitData('stale redraw')

      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
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
        cwd: '/tmp',
        worktreeId: 'repo-1::/tmp'
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
        cwd: '/tmp',
        worktreeId: 'repo-1::/tmp'
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

    expect(
      handlers.get('pty:writeAccepted')!(mainWindowIpcEvent, {
        id: result.id,
        data: '\x03'
      })
    ).toBe(true)
    expect(mockProc.proc.write).toHaveBeenCalledWith('\x03')
    expect(
      handlers.get('pty:writeAccepted')!(mainWindowIpcEvent, {
        id: 'missing-pty-for-write-ack',
        data: '\x03'
      })
    ).toBe(false)
    expect(mockProc.proc.write).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed and cross-window pty write IPC before provider writes', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const write = getPtyWriteListener() as (event: unknown, args: unknown) => void
    const writeAccepted = handlers.get('pty:writeAccepted')! as (
      event: unknown,
      args: unknown
    ) => unknown

    write(mainWindowIpcEvent, null)
    write(mainWindowIpcEvent, { id: '', data: 'x' })
    write(mainWindowIpcEvent, { id: result.id, data: 1 })
    write(foreignWindowIpcEvent, { id: result.id, data: 'x' })

    expect(writeAccepted(mainWindowIpcEvent, null)).toBe(false)
    expect(writeAccepted(mainWindowIpcEvent, { id: '', data: 'x' })).toBe(false)
    expect(writeAccepted(mainWindowIpcEvent, { id: result.id, data: 1 })).toBe(false)
    expect(writeAccepted(foreignWindowIpcEvent, { id: result.id, data: 'x' })).toBe(false)
    expect(mockProc.proc.write).not.toHaveBeenCalled()
  })

  it('silently drops writes to a live PTY after ownership loss until pty:listSessions rebuilds it (frozen-terminal repro)', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const write = getPtyWriteListener()

    write(mainWindowIpcEvent, { id: result.id, data: 'alive' })
    expect(mockProc.proc.write).toHaveBeenCalledWith('alive')

    // Field failure shape (Discord #performance / #2836): a pane can keep
    // rendering with a ptyId whose ownership entry is gone while the provider
    // still holds the live PTY — every keystroke then vanishes with no error,
    // no log, and no signal back to the renderer.
    deletePtyOwnership(result.id)
    write(mainWindowIpcEvent, { id: result.id, data: 'dropped' })
    expect(mockProc.proc.write).not.toHaveBeenCalledWith('dropped')

    // pty:listSessions rebuilds ownership from provider sessions — the
    // revival lever the frozen-pane e2e probes depend on.
    await handlers.get('pty:listSessions')!(null, undefined)
    write(mainWindowIpcEvent, { id: result.id, data: 'revived' })
    expect(mockProc.proc.write).toHaveBeenCalledWith('revived')
  })

  it('chunks large acknowledged pty writes before provider writes', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const text = ['x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES), 'tail'].join('')

    await expect(
      handlers.get('pty:writeAccepted')!(mainWindowIpcEvent, { id: result.id, data: text })
    ).resolves.toBe(true)

    expect(mockProc.proc.write).toHaveBeenNthCalledWith(
      1,
      'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)
    )
    expect(mockProc.proc.write).toHaveBeenNthCalledWith(2, 'tail')
  })

  it('yields while validating accepted large acknowledged pty writes before provider writes', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

    vi.useFakeTimers()
    const writeResult = handlers.get('pty:writeAccepted')!(mainWindowIpcEvent, {
      id: result.id,
      data: text
    })

    expect(writeResult).toBeInstanceOf(Promise)
    expect(mockProc.proc.write).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()
    await expect(writeResult).resolves.toBe(true)
    expect(mockProc.proc.write.mock.calls.map(([chunk]) => chunk).join('')).toBe(text)
  })

  it('rejects oversized acknowledged pty writes before provider writes', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }

    expect(
      handlers.get('pty:writeAccepted')!(mainWindowIpcEvent, {
        id: result.id,
        data: 'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1)
      })
    ).toBe(false)
    expect(mockProc.proc.write).not.toHaveBeenCalled()
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
      noteTerminalSpawnCommand: vi.fn(),
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
      expect.any(String),
      expect.any(Number),
      { authorityVerified: true }
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
        worktreeId: 'repo-1::/tmp',
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
      noteTerminalSpawnCommand: vi.fn(),
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
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never, runtime as never)
    // Why both: a reload fires the hidden-delivery gate reset AND the orphan
    // cleanup; invoke every registered listener like a real did-finish-load.
    const didFinishLoadHandlers = mainWindow.webContents.on.mock.calls
      .filter(([eventName]) => eventName === 'did-finish-load')
      .map(([, handler]) => handler as () => void)
    expect(didFinishLoadHandlers.length).toBeGreaterThan(0)
    const didFinishLoad = (): void => {
      for (const handler of didFinishLoadHandlers) {
        handler()
      }
    }
    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    // The first load after spawn only advances generation. The second one sees
    // this PTY as belonging to a prior page load and kills it as orphaned.
    didFinishLoad()
    didFinishLoad()

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
      isFocused: () => true,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: {
        on: vi.fn(),
        send: vi.fn(),
        removeListener: vi.fn()
      }
    }
    const secondWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: {
        on: vi.fn(),
        send: vi.fn(),
        removeListener: vi.fn()
      }
    }

    registerPtyHandlers(firstWindow as never)
    // Two listeners on the first (LocalPtyProvider) window: the renderer-gate
    // reset and the orphan cleanup.
    const firstWindowLoadHandlers = firstWindow.webContents.on.mock.calls.filter(
      ([eventName]) => eventName === 'did-finish-load'
    )
    expect(firstWindowLoadHandlers).toHaveLength(2)

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

    // Every first-window load listener was detached from its webContents.
    for (const [, handler] of firstWindowLoadHandlers) {
      expect(firstWindow.webContents.removeListener).toHaveBeenCalledWith(
        'did-finish-load',
        handler
      )
    }
    // The non-Local provider keeps orphan cleanup off the second window —
    // only the renderer-gate reset listener remains.
    expect(
      secondWindow.webContents.on.mock.calls.filter(
        ([eventName]) => eventName === 'did-finish-load'
      )
    ).toHaveLength(1)
  })

  // Why (#5787): a crash/freeze-recovery reload re-fires did-finish-load on the
  // single window. The orphan sweep must be suppressed for it so live LOCAL PTYs
  // stay attached until session restore re-adopts them.
  it('does not sweep local PTYs during a recovery reload', async () => {
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn(() => makeDisposable()),
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
    const isRecoveryReloadInFlight = vi.fn(() => true)
    const markClaudePtyExitedSpy = vi.spyOn(livePtyGate, 'markClaudePtyExited')

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { isRecoveryReloadInFlight }
    )
    // This branch registers two did-finish-load listeners (renderer delivery-gate
    // reset first, orphan sweep second); a real reload fires both, so must we —
    // otherwise the suppression assertion passes vacuously without reaching the sweep.
    const didFinishLoadHandlers = mainWindow.webContents.on.mock.calls
      .filter(([eventName]) => eventName === 'did-finish-load')
      .map(([, handler]) => handler as () => void)
    expect(didFinishLoadHandlers.length).toBeGreaterThan(0)
    const didFinishLoad = (): void => didFinishLoadHandlers.forEach((handler) => handler())

    const spawnResult = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as {
      id: string
    }

    // Without the guard the second load would sweep this PTY as a prior-generation
    // orphan. Under recovery-in-flight neither load may touch it.
    didFinishLoad()
    didFinishLoad()

    expect(killSpy).not.toHaveBeenCalled()
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(markClaudePtyExitedSpy).not.toHaveBeenCalled()
    const listed = await getLocalPtyProvider().listProcesses()
    expect(listed.some((info) => info.id === spawnResult.id)).toBe(true)

    markClaudePtyExitedSpy.mockRestore()
  })

  // Why: guard against over-suppression — when no recovery reload is in flight the
  // sweep MUST still reclaim genuinely orphaned local PTYs.
  it('still sweeps orphaned local PTYs when no recovery reload is in flight', async () => {
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn(() => makeDisposable()),
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
    const isRecoveryReloadInFlight = vi.fn(() => false)

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { isRecoveryReloadInFlight }
    )
    // This branch registers two did-finish-load listeners (renderer delivery-gate
    // reset first, orphan sweep second); a real reload fires both, so must we.
    const didFinishLoadHandlers = mainWindow.webContents.on.mock.calls
      .filter(([eventName]) => eventName === 'did-finish-load')
      .map(([, handler]) => handler as () => void)
    const didFinishLoad = (): void => didFinishLoadHandlers.forEach((handler) => handler())

    const spawnResult = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as {
      id: string
    }

    // First load only advances the generation; the second sees this PTY as a
    // prior-load orphan. With the flag false the guard must NOT suppress the sweep.
    didFinishLoad()
    didFinishLoad()

    expect(killSpy).toHaveBeenCalled()
    expect(runtime.onPtyExit).toHaveBeenCalledWith(spawnResult.id, -1)
    const listed = await getLocalPtyProvider().listProcesses()
    expect(listed.some((info) => info.id === spawnResult.id)).toBe(false)
  })

  // Why (#5787): two PTYs spawned in different load generations must BOTH survive a
  // recovery reload — even the older one that a normal sweep would reclaim.
  it('keeps local PTYs from different generations alive across recovery reloads', async () => {
    const killSpyA = vi.fn()
    const killSpyB = vi.fn()
    const runtime = {
      setPtyController: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    const isRecoveryReloadInFlight = vi.fn(() => true)

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { isRecoveryReloadInFlight }
    )
    // Fire ALL did-finish-load listeners (gate reset + orphan sweep), as a
    // real reload does — the sweep listener is the one under test.
    const didFinishLoadHandlers = mainWindow.webContents.on.mock.calls
      .filter(([eventName]) => eventName === 'did-finish-load')
      .map(([, handler]) => handler as () => void)
    const didFinishLoad = (): void => didFinishLoadHandlers.forEach((handler) => handler())

    spawnMock.mockReturnValue({
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: killSpyA,
      process: 'zsh',
      pid: 111
    })
    const ptyA = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as { id: string }

    // Advance the generation without sweeping (recovery-in-flight), then spawn a
    // second PTY so the two live in different load generations.
    didFinishLoad()

    spawnMock.mockReturnValue({
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: killSpyB,
      process: 'zsh',
      pid: 222
    })
    const ptyB = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as { id: string }

    didFinishLoad()

    expect(killSpyA).not.toHaveBeenCalled()
    expect(killSpyB).not.toHaveBeenCalled()
    const ids = (await getLocalPtyProvider().listProcesses()).map((info) => info.id)
    expect(ids).toContain(ptyA.id)
    expect(ids).toContain(ptyB.id)
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
    it('returns a hidden-output recovery snapshot with clamped scrollback', async () => {
      const runtime = {
        setPtyController: vi.fn(),
        getPtyOutputSequence: vi.fn(() => 42),
        serializeHiddenOutputRecoveryBuffer: vi.fn().mockResolvedValue({
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

      expect(runtime.serializeHiddenOutputRecoveryBuffer).toHaveBeenCalledWith('pty-1', {
        scrollbackRows: 50_000
      })
      // Why pendingDeliveryStartSeq === seq: the pending renderer-delivery
      // queue is empty, so the renderer's post-restore duplicate window is
      // empty too — low-seq live chunks (fresh seq domain) must not be
      // dropped against the snapshot baseline.
      expect(result).toEqual({
        data: 'snapshot\r\n',
        cols: 120,
        rows: 40,
        cwd: '/projects/restored',
        seq: 42,
        pendingDeliveryStartSeq: 42,
        source: 'headless'
      })
    })

    it('uses the complete provider model after daemon stream thinning', async () => {
      const provider = installObservableDaemonTestProvider()
      provider.getBufferSnapshot.mockResolvedValue({
        data: 'complete daemon scrollback\r\n',
        cols: 100,
        rows: 30,
        seq: 900,
        source: 'headless'
      })
      const runtime = {
        setPtyController: vi.fn(),
        getPtyOutputSequence: vi.fn(() => 640),
        notePtyDataGap: vi.fn(),
        onPtyExit: vi.fn(),
        serializeHiddenOutputRecoveryBuffer: vi.fn().mockResolvedValue({
          data: 'kept tail only\r\n',
          cols: 100,
          rows: 30,
          seq: 640,
          source: 'headless'
        })
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      provider.emitDataGap('daemon-pty', 512)

      const result = await handlers.get('pty:getMainBufferSnapshot')!(null, {
        id: 'daemon-pty',
        opts: { scrollbackRows: 5000 }
      })

      expect(runtime.notePtyDataGap).toHaveBeenCalledWith('daemon-pty', 512)
      expect(provider.getBufferSnapshot).toHaveBeenCalledWith('daemon-pty', {
        scrollbackRows: 5000
      })
      expect(runtime.serializeHiddenOutputRecoveryBuffer).not.toHaveBeenCalled()
      expect(result).toEqual({
        data: 'complete daemon scrollback\r\n',
        cols: 100,
        rows: 30,
        seq: 900,
        source: 'headless',
        // Bytes between main's current absolute seq and the daemon snapshot
        // may still be queued on the stream socket and must dedupe on arrival.
        pendingDeliveryStartSeq: 640
      })
      provider.emitExit('daemon-pty')
    })

    it("never paints main's incomplete tail when a required provider snapshot is unavailable", async () => {
      const provider = installObservableDaemonTestProvider()
      provider.getBufferSnapshot.mockResolvedValue(null)
      const runtime = {
        setPtyController: vi.fn(),
        getPtyOutputSequence: vi.fn(() => 640),
        notePtyDataGap: vi.fn(),
        onPtyExit: vi.fn(),
        serializeHiddenOutputRecoveryBuffer: vi.fn().mockResolvedValue({
          data: 'kept tail only\r\n',
          cols: 100,
          rows: 30,
          seq: 640,
          source: 'headless'
        })
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      provider.emitDataGap('daemon-pty', 512)

      const result = await handlers.get('pty:getMainBufferSnapshot')!(null, {
        id: 'daemon-pty',
        opts: { scrollbackRows: 5000 }
      })

      expect(provider.getBufferSnapshot).toHaveBeenCalledWith('daemon-pty', {
        scrollbackRows: 5000
      })
      expect(runtime.serializeHiddenOutputRecoveryBuffer).not.toHaveBeenCalled()
      expect(result).toBeNull()
      provider.emitExit('daemon-pty')
    })

    it('reports where the undelivered pending backlog starts alongside the snapshot', async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)
      const runtime = {
        setPtyController: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        preAllocateHandleForPty: vi.fn(() => null),
        getPtyOutputSequence: vi.fn(() => 2_472),
        hasRemoteTerminalViewSubscriber: vi.fn(() => false),
        serializeHiddenOutputRecoveryBuffer: vi.fn().mockResolvedValue({
          data: 'snapshot\r\n',
          cols: 100,
          rows: 30,
          seq: 2_472,
          source: 'headless'
        })
      }
      try {
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }

        // Starved pending entry: bytes ingested up to seq 2_472 but not yet
        // flushed to the renderer — they can still arrive after the snapshot.
        mockProc.emitData('frame-bytes')

        const result = (await handlers.get('pty:getMainBufferSnapshot')!(null, {
          id: spawnResult.id
        })) as { pendingDeliveryStartSeq?: number }

        expect(result.pendingDeliveryStartSeq).toBe(2_472 - 'frame-bytes'.length)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
