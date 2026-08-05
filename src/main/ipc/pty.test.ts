/* eslint-disable max-lines -- Why: stateful registration helper + shared mocked IPC/node-pty harness keep spawn-env assertions in one focused file. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userInfo } from 'node:os'
import { delimiter, join, posix } from 'node:path'
import { prepareCodexSessionResume } from '../codex/codex-session-resume-preparation'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES
} from '../../shared/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../shared/clipboard-text'
import { redactPtyIdForDiagnostics } from '../../shared/pty-delivery-diagnostics'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultWorkspaceSession } from '../../shared/constants'
import type { TuiAgent } from '../../shared/types'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import { AGENT_SESSION_CLAIM_DIGEST_VERSION } from '../../shared/agent-session-host-authority'
import { PtyWriteUnavailableError } from '../providers/pty-write-unavailable-error'

const isWindowsHost = process.platform === 'win32'
const posixOnlyIt = isWindowsHost ? it.skip : it
// Why: bare shells no longer mkdir ~/.omp; OMP status lives under userData (#10196).
const expectedOmpStatusExtension = posix.join(
  '/tmp/orca-user-data',
  'omp-managed-status-extension',
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
  loginPreflightExecFileMock,
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
  clearPaneKeyAliasesForPtyMock,
  recordCodexPaneAccountMock,
  forgetCodexPaneAccountMock
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
  loginPreflightExecFileMock: vi.fn(),
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
  clearPaneKeyAliasesForPtyMock: vi.fn(),
  recordCodexPaneAccountMock: vi.fn(),
  forgetCodexPaneAccountMock: vi.fn()
}))

vi.mock('electron', () => ({
  // Why defined-but-undefined: the real OrcaRuntimeService guards BrowserWindow with `?.`; vitest throws on reading exports the mock omits.
  BrowserWindow: undefined,
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

// Why: this suite forces darwin on non-macOS hosts; isolate the PAM probe while preserving other child_process APIs.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFile: loginPreflightExecFileMock
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

// Why: the real ensure writes to process.resourcesPath (absent under vitest); env assembly only needs the returned dir path.
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

vi.mock('../codex/codex-pane-account-registry', () => ({
  recordCodexPaneAccount: recordCodexPaneAccountMock,
  forgetCodexPaneAccount: forgetCodexPaneAccountMock
}))
import {
  LocalPtyProvider,
  _resetLocalPtyProviderStateForTest
} from '../providers/local-pty-provider'
import { makePaneKey } from '../../shared/stable-pane-id'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
import {
  registerPtyHandlers,
  registerSshPtyProvider,
  clearPtyOwnershipForConnection,
  clearProviderPtyState,
  deletePtyOwnership,
  getPtyRendererDeliveryDebugSnapshot,
  getPtyIdsForConnection,
  resetPtyRendererDeliveryDebug,
  getPtyIdForPaneKey,
  hasPendingRendererSerializerForPaneKey,
  setPtyOwnership,
  setLocalPtyProvider,
  rebindLocalProviderListeners,
  resolveCodexHomeAfterManagedAuthReadiness,
  unregisterSshPtyProvider,
  getLocalPtyProvider,
  isCurrentPtyExit,
  restorePtyIncarnation,
  type PrepareCodexSessionResume
} from './pty'
import { resetMacosLoginShellPreflightForTests } from '../providers/macos-tcc-login-shell'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  isHiddenRendererPty
} from './pty-hidden-delivery-gate'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { hasLiveClaudePtys, markClaudePtySpawned } from '../claude-accounts/live-pty-gate'
import * as livePtyGate from '../claude-accounts/live-pty-gate'
import {
  SSH_PTY_IDENTITY_MISMATCH_ERROR,
  SSH_SESSION_EXPIRED_ERROR
} from '../providers/ssh-pty-errors'
import { resolveWindowsShellLaunchArgs } from '../providers/windows-shell-args'
import { _resetWslCachesForTests, _setWslCachesForTests } from '../wsl'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
import { acquireWatcherRemovalGate } from './watcher-removal-gate'
import { __resetShellStartupEnvCache } from '../pty/shell-startup-env'
import {
  acceptSshPtyOutputData,
  acceptSshPtyOutputExit,
  closeSshPtyOutputGeneration
} from './ssh-pty-output-intake-registry'

// Why: Windows resolves a bare PowerShell name to an absolute exe before ConPTY, else CreateProcessW fails with error 5 (PR #6537 / #5161).
const RESOLVED_WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const RESOLVED_PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
// Why: default spawn cwd in the Windows UTF-8 suite is USERPROFILE; derive shell
// args from the production resolver so expectations stay in lockstep when the
// PowerShell bootstrap grows (e.g. cwd restore after profiles load).
const DEFAULT_WINDOWS_PTY_CWD = 'C:\\Users\\test'
function powerShellOsc133ArgsForCwd(cwd: string = DEFAULT_WINDOWS_PTY_CWD): string[] {
  return resolveWindowsShellLaunchArgs(RESOLVED_WINDOWS_POWERSHELL, cwd, cwd).shellArgs
}
const POWERSHELL_OSC133_ARGS = powerShellOsc133ArgsForCwd()
const TEST_CODEX_HOME =
  process.platform === 'win32'
    ? 'C:\\Users\\test\\AppData\\Roaming\\orca\\codex-runtime-home\\home'
    : '/tmp/orca-codex-home'
const TEST_CODEX_AUTH_JSON = JSON.stringify({
  tokens: {
    access_token: 'access',
    id_token: 'e30.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifQ.sig',
    refresh_token: 'refresh',
    account_id: 'account'
  },
  last_refresh: '2026-07-31T00:00:00Z'
})

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
      removeListener: vi.fn()
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
    // Why: most PTY spawn tests assert POSIX shell behavior; Windows cases opt into win32 explicitly below.
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    // Why: forced darwin makes the TCC login(1) wrapper rewrite every asserted argv; its own test below re-enables it.
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
    loginPreflightExecFileMock.mockReset()
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
    recordCodexPaneAccountMock.mockReset()
    forgetCodexPaneAccountMock.mockReset()
    mainWindow.webContents.on.mockReset()
    mainWindow.webContents.send.mockReset()
    mainWindow.webContents.removeListener.mockReset()
    // Why: hidden-delivery gate state is module-level (PTY-keyed), so tests must not leak hidden bits across cases.
    _resetHiddenRendererPtyDeliveryGateForTest()
    __resetShellStartupEnvCache()

    // Why: mirror real Electron — ipcMain.handle throws on a duplicate channel, catching re-registration that forgot removeHandler.
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      handlers.set(channel, handler)
    })
    removeHandlerMock.mockImplementation((channel: string) => {
      handlers.delete(channel)
    })
    // Why: production gates PTY sends on pty:rendererDispatcherReady; model a live page by firing the handshake as soon as it registers.
    onMock.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === 'pty:rendererDispatcherReady') {
        listener(mainWindowIpcEvent)
        // Drain the handshake's empty flush so it can't later perturb send-timing assertions.
        if (vi.isFakeTimers()) {
          vi.advanceTimersByTime(0)
        }
      }
    })
    getPathMock.mockReturnValue('/tmp/orca-user-data')
    // Why: wrapper roots resolve from ORCA_USER_DATA_PATH; mirror the mocked userData so ZDOTDIR/wrapper assertions match.
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
      (
        _ptyId: string,
        existingAgentDir?: string,
        kind?: string,
        options?: { materializeDefaultHome?: boolean }
      ) => {
        const materializeDefaultHome = options?.materializeDefaultHome !== false
        if (kind === 'omp') {
          // Why: bare shells no longer create ~/.omp; only a userData status path is set (#10196).
          if (!existingAgentDir && !materializeDefaultHome) {
            return {
              ORCA_OMP_STATUS_EXTENSION:
                '/tmp/orca-user-data/omp-managed-status-extension/orca-agent-status.ts'
            }
          }
          return {
            ORCA_OMP_SOURCE_AGENT_DIR: existingAgentDir ?? '/tmp/default-omp-agent',
            ORCA_OMP_STATUS_EXTENSION: `${existingAgentDir ?? '/tmp/default-omp-agent'}/extensions/orca-agent-status.ts`
          }
        }
        if (!existingAgentDir && !materializeDefaultHome) {
          return {}
        }
        return {
          ORCA_PI_SOURCE_AGENT_DIR: existingAgentDir ?? '/tmp/default-pi-agent'
        }
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
    _resetLocalPtyProviderStateForTest()
    _resetWslCachesForTests()
    vi.useRealTimers()
    // Why: sshProviders is module-level state; a leftover id leaks into later tests (pty:listSessions sweeps every provider).
    for (const leakedConnectionId of [
      'ssh-1',
      'ssh-a',
      'ssh-b',
      'ssh-expired-runtime',
      'ssh-fresh-fail',
      'ssh-reattach-1',
      'ssh-reattach-fail',
      'ssh-reattach-ok',
      'ssh-runtime-env',
      'ssh-generation-replacement'
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

  function installDaemonTestProvider(overrides: Record<string, unknown> = {}) {
    const spawn = vi.fn(async (options: { sessionId?: string }) => ({
      id: options.sessionId ?? 'daemon-pty'
    }))
    const provider = {
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
      getProfiles: vi.fn(),
      ...overrides
    }
    setLocalPtyProvider(provider as never)
    return spawn
  }

  function installObservableDaemonTestProvider() {
    const spawn = vi.fn(async (options: { sessionId?: string }) => ({
      id: options.sessionId ?? 'daemon-pty'
    }))
    const write = vi.fn()
    const pauseProducer = vi.fn()
    const resumeProducer = vi.fn()
    const shutdown = vi.fn()
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
      shutdown,
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
      shutdown,
      getBufferSnapshot,
      emitData: (id: string, data: string) => dataHandler?.({ id, data }),
      emitExit: (id: string, code = 0) => exitHandler?.({ id, code }),
      emitDataGap: (id: string, droppedChars: number) =>
        backgroundStreamHandler?.({ id, kind: 'dataGap', droppedChars })
    }
  }

  function createAgentClaimProvider(args: {
    sessions?: {
      id: string
      incarnationId?: string
      cwd: string
      title: string
      agentSessionOwners?: AgentSessionOwnerBinding[]
    }[]
    livePtyIds?: ReadonlySet<string>
    spawn?: ReturnType<typeof vi.fn>
    authoritativeOwnerListings?: boolean
  }) {
    return {
      spawn: args.spawn ?? vi.fn(async () => ({ id: 'unexpected-spawn' })),
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
      listProcesses: vi.fn(async () => args.sessions ?? []),
      providesAgentSessionOwnerListings: vi.fn(() => args.authoritativeOwnerListings !== false),
      hasPty: vi.fn((id: string) => args.livePtyIds?.has(id) ?? false),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    }
  }

  const recoveredAgentClaim = {
    digestVersion: 1 as const,
    keyId: 'claim-key',
    identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    agent: 'codex' as const
  }
  const recoveredAgentSurface = {
    worktreeId: 'repo-1::/tmp/recovered-worktree',
    tabId: '11111111-1111-4111-8111-111111111111',
    leafId: '22222222-2222-4222-8222-222222222222',
    terminalHandle: 'term_recovered'
  }

  function registerAgentClaimController(): {
    spawn: (args: Record<string, unknown>) => Promise<unknown>
    write: (ptyId: string, data: string) => boolean
    resize: (ptyId: string, cols: number, rows: number) => boolean
    probePtyLiveness: (ptyId: string) => Promise<boolean | null>
    attach: (ptyId: string) => Promise<boolean>
  } {
    let controller:
      | {
          spawn: (args: Record<string, unknown>) => Promise<unknown>
          write: (ptyId: string, data: string) => boolean
          resize: (ptyId: string, cols: number, rows: number) => boolean
          probePtyLiveness: (ptyId: string) => Promise<boolean | null>
          attach: (ptyId: string) => Promise<boolean>
        }
      | undefined
    const runtime = {
      setPtyController: vi.fn((next) => {
        controller = next
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_recovered'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    if (!controller) {
      throw new Error('PTY controller was not registered')
    }
    return controller
  }

  it('fails closed instead of routing encoded SSH PTY writes locally after disconnect', () => {
    const connectionId = 'ssh-1'
    const ptyId = `ssh:${connectionId}@@remote-pty`
    const localProvider = createAgentClaimProvider({})
    const sshProvider = createAgentClaimProvider({})
    setLocalPtyProvider(localProvider as never)
    registerSshPtyProvider(connectionId, sshProvider as never)
    setPtyOwnership(ptyId, connectionId)
    const controller = registerAgentClaimController()

    unregisterSshPtyProvider(connectionId)
    clearPtyOwnershipForConnection(connectionId)

    expect(controller.write(ptyId, 'input')).toBe(false)
    expect(controller.resize(ptyId, 100, 40)).toBe(false)
    expect(localProvider.write).not.toHaveBeenCalled()
    expect(localProvider.resize).not.toHaveBeenCalled()

    registerSshPtyProvider(connectionId, sshProvider as never)
    expect(controller.write(ptyId, 'reconnected')).toBe(true)
    expect(controller.resize(ptyId, 120, 50)).toBe(true)
    expect(sshProvider.write).toHaveBeenCalledWith(ptyId, 'reconnected')
    expect(sshProvider.resize).toHaveBeenCalledWith(ptyId, 120, 50)

    unregisterSshPtyProvider(connectionId)
    clearProviderPtyState(ptyId)
  })

  describe('controller probePtyLiveness routing', () => {
    it('proves absence for an id the in-process local provider never owned', async () => {
      setLocalPtyProvider(new LocalPtyProvider())
      const controller = registerAgentClaimController()

      await expect(controller.probePtyLiveness('pty-from-prior-run')).resolves.toBe(false)
    })

    it('delegates to a provider-exposed probe and preserves its answer', async () => {
      const provider = {
        ...createAgentClaimProvider({}),
        probePtyLiveness: vi.fn(async () => true)
      }
      setLocalPtyProvider(provider as never)
      const controller = registerAgentClaimController()

      await expect(controller.probePtyLiveness('daemon-owned')).resolves.toBe(true)
      expect(provider.probePtyLiveness).toHaveBeenCalledWith('daemon-owned')
    })

    it('answers unknown for a probe-less provider that is not the in-process one', async () => {
      // Why: only the in-process provider is its own sole owner; any other
      // probe-less provider's ignorance is doubt, not absence.
      setLocalPtyProvider(createAgentClaimProvider({}) as never)
      const controller = registerAgentClaimController()

      await expect(controller.probePtyLiveness('pty-unknown')).resolves.toBeNull()
    })

    it('answers unknown for SSH-owned ids whose provider has no probe', async () => {
      const connectionId = 'ssh-probe-1'
      const ptyId = `ssh:${connectionId}@@remote-pty`
      setLocalPtyProvider(new LocalPtyProvider())
      registerSshPtyProvider(connectionId, createAgentClaimProvider({}) as never)
      setPtyOwnership(ptyId, connectionId)
      const controller = registerAgentClaimController()
      try {
        await expect(controller.probePtyLiveness(ptyId)).resolves.toBeNull()

        unregisterSshPtyProvider(connectionId)
        // A disconnected SSH provider is an error path, and errors never prove absence.
        await expect(controller.probePtyLiveness(ptyId)).resolves.toBeNull()
      } finally {
        unregisterSshPtyProvider(connectionId)
        clearPtyOwnershipForConnection(connectionId)
        clearProviderPtyState(ptyId)
      }
    })

    it('answers unknown for remote-scoped ids without consulting local providers', async () => {
      // Why: a locally routed provider would answer confidently — and wrongly —
      // for a PTY that lives on a remote Orca host.
      setLocalPtyProvider(new LocalPtyProvider())
      const controller = registerAgentClaimController()

      await expect(controller.probePtyLiveness('remote:some-remote-pty')).resolves.toBeNull()
    })

    it('answers unknown when the provider probe throws', async () => {
      const provider = {
        ...createAgentClaimProvider({}),
        probePtyLiveness: vi.fn(async () => {
          throw new Error('probe transport down')
        })
      }
      setLocalPtyProvider(provider as never)
      const controller = registerAgentClaimController()

      await expect(controller.probePtyLiveness('daemon-owned')).resolves.toBeNull()
    })
  })

  it('routes controller attach to the local daemon provider only, false on doubt', async () => {
    const localProvider = createAgentClaimProvider({})
    const sshProvider = createAgentClaimProvider({})
    setLocalPtyProvider(localProvider as never)
    registerSshPtyProvider('ssh-attach', sshProvider as never)
    const controller = registerAgentClaimController()
    const daemonPtyId = 'repo-1::/tmp/wt@@1a2b3c4d'
    const ownedSshPtyId = 'owned-remote-pty'
    setPtyOwnership(ownedSshPtyId, 'ssh-attach')
    try {
      // Local daemon session: attach flows to the provider.
      await expect(controller.attach(daemonPtyId)).resolves.toBe(true)
      expect(localProvider.attach).toHaveBeenCalledWith(daemonPtyId)

      // SSH-scoped sessions are excluded — leases handle their reattach.
      await expect(controller.attach(ownedSshPtyId)).resolves.toBe(false)
      await expect(controller.attach('ssh:ssh-attach@@relay-pty')).resolves.toBe(false)
      expect(sshProvider.attach).not.toHaveBeenCalled()

      // Provider refusal (absent/unprovable session) answers false, not throw.
      localProvider.attach.mockRejectedValueOnce(new Error('Session not found'))
      await expect(controller.attach(daemonPtyId)).resolves.toBe(false)

      // The in-process local provider streams without attach; never called.
      const inProcess = new LocalPtyProvider()
      const inProcessAttach = vi.spyOn(inProcess, 'attach')
      setLocalPtyProvider(inProcess)
      await expect(controller.attach(daemonPtyId)).resolves.toBe(false)
      expect(inProcessAttach).not.toHaveBeenCalled()
    } finally {
      unregisterSshPtyProvider('ssh-attach')
      clearPtyOwnershipForConnection('ssh-attach')
      clearProviderPtyState(ownedSshPtyId)
    }
  })

  it('does not dispatch a runtime PTY spawn after its client disconnects', async () => {
    const provider = createAgentClaimProvider({})
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController()
    const abort = new AbortController()
    abort.abort()

    await expect(
      controller.spawn({ cols: 80, rows: 24, cwd: '/tmp/worktree', signal: abort.signal })
    ).rejects.toThrow('client_disconnected')
    expect(provider.spawn).not.toHaveBeenCalled()
  })

  it('rejects a canonical daemon owner that exited before its spawn reply', async () => {
    const claim = {
      ...recoveredAgentClaim,
      identityDigest: 'ededededededededededededededededededededede'
    }
    const canonicalOwner: AgentSessionOwnerBinding = {
      claim,
      generation: 'generation-canonical-exited',
      phase: 'live',
      ptyId: 'pty-canonical-exited',
      surface: recoveredAgentSurface
    }
    const physicalSpawn = vi.fn(async () => ({
      id: canonicalOwner.ptyId,
      incarnationId: 'incarnation-canonical-exited',
      exitedBeforeSpawnReply: true as const,
      agentSessionEnsure: { disposition: 'adopted' as const, owner: canonicalOwner }
    }))
    const provider = createAgentClaimProvider({ spawn: physicalSpawn })
    setLocalPtyProvider(provider as never)
    let controller: { spawn(args: Record<string, unknown>): Promise<unknown> } | undefined
    const runtime = {
      setPtyController: vi.fn((next) => {
        controller = next
      }),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)

    await expect(
      controller!.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        sessionId: 'different-requested-id',
        agentSessionEnsure: { claim, surface: recoveredAgentSurface }
      })
    ).rejects.toThrow('agent_session_exited_during_start')

    expect(physicalSpawn).toHaveBeenCalledOnce()
    expect(runtime.registerPty).not.toHaveBeenCalled()
    expect(runtime.registerPreAllocatedHandleForPty).not.toHaveBeenCalled()
    expect(runtime.cancelPendingPtyRegistration).toHaveBeenCalledWith(
      'different-requested-id',
      'incarnation-canonical-exited'
    )
  })

  it('rejects renderer spawn publication when the provider reply proves exit', async () => {
    const connectionId = 'ssh-renderer-exited-reply'
    const appPtyId = `ssh:${connectionId}@@relay-pty`
    const provider = {
      spawn: vi.fn(async () => ({
        id: appPtyId,
        incarnationId: 'incarnation-renderer-exited',
        exitedBeforeSpawnReply: true as const
      })),
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
    }
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(),
      removeSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn(),
      retireLeaseAndReap: vi.fn(),
      clearSshRemotePtyLeaseReapFlag: vi.fn()
    }
    const runtime = {
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_renderer_exited'),
      preAllocateHandleForPty: vi.fn(() => 'term_renderer_exited'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    registerSshPtyProvider(connectionId, provider as never)
    try {
      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        undefined,
        store as never
      )
      const leafId = '33333333-3333-4333-8333-333333333333'

      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp/worktree',
          connectionId,
          worktreeId: 'repo::/tmp/worktree',
          tabId: 'tab-renderer-exited',
          leafId
        })
      ).rejects.toThrow('agent_session_exited_during_start')

      expect(runtime.registerPty).not.toHaveBeenCalled()
      expect(runtime.registerPreAllocatedHandleForPty).not.toHaveBeenCalled()
      expect(store.persistPtyBinding).not.toHaveBeenCalled()
      expect(store.upsertSshRemotePtyLease).not.toHaveBeenCalled()
      expect(getPtyIdsForConnection(connectionId)).toEqual([])
    } finally {
      unregisterSshPtyProvider(connectionId)
    }
  })

  it('rejects renderer persistence when a local PTY exits before spawn settles', async () => {
    const ptyId = 'pty-renderer-early-exit'
    const incarnationId = 'incarnation-renderer-early-exit'
    const runtime = new OrcaRuntimeService()
    const registerRuntimePty = vi.spyOn(runtime, 'registerPty')
    const provider = createAgentClaimProvider({
      spawn: vi.fn(async () => {
        runtime.onPtySpawned(ptyId, incarnationId)
        runtime.onPtyExit(ptyId, 0, incarnationId)
        return { id: ptyId, incarnationId }
      }),
      authoritativeOwnerListings: false
    })
    const store = { persistPtyBinding: vi.fn() }
    setLocalPtyProvider(provider as never)
    registerPtyHandlers(
      mainWindow as never,
      runtime,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const leafId = '44444444-4444-4444-8444-444444444444'

    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp/worktree',
        worktreeId: 'repo::/tmp/worktree',
        tabId: 'tab-renderer-early-exit',
        leafId
      })
    ).rejects.toThrow('agent_session_exited_during_start')

    expect(store.persistPtyBinding).not.toHaveBeenCalled()
    expect(registerRuntimePty).not.toHaveBeenCalled()
    const internals = runtime as unknown as {
      earlyExitedPtyIncarnations: Map<string, string | null>
      pendingPtyRegistrationIncarnations: Map<string, string | null>
    }
    expect(internals.earlyExitedPtyIncarnations.size).toBe(0)
    expect(internals.pendingPtyRegistrationIncarnations.size).toBe(0)
    clearProviderPtyState(ptyId)
  })

  it('adopts a live controller-owned local fallback when listings cannot serialize claims', async () => {
    const sessions: {
      id: string
      incarnationId: string
      cwd: string
      title: string
    }[] = []
    const physicalSpawn = vi.fn(async () => {
      const result = { id: 'pty-local-claim', incarnationId: 'incarnation-local-claim' }
      sessions.push({ ...result, cwd: '/tmp/worktree', title: 'Codex' })
      return result
    })
    const provider = createAgentClaimProvider({
      sessions,
      spawn: physicalSpawn,
      authoritativeOwnerListings: false
    })
    Object.assign(provider, { routesFreshSpawnsToLocalProvider: true })
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController()
    const request = {
      cols: 80,
      rows: 24,
      cwd: '/tmp/worktree',
      agentSessionEnsure: {
        claim: recoveredAgentClaim,
        surface: recoveredAgentSurface
      }
    }

    await expect(controller.spawn(request)).resolves.toMatchObject({
      agentSessionEnsure: { disposition: 'created' }
    })
    await expect(controller.spawn(request)).resolves.toMatchObject({
      id: 'pty-local-claim',
      agentSessionEnsure: { disposition: 'adopted' }
    })
    expect(physicalSpawn).toHaveBeenCalledOnce()
    clearProviderPtyState('pty-local-claim')
  })

  it.each(['runtime controller', 'renderer IPC'] as const)(
    'recovers degraded fresh-spawn routing before %s chooses daemon host semantics',
    async (entryPoint) => {
      let degraded = true
      const daemonSpawn = vi.fn(async (options: { sessionId?: string }) => ({
        id: options.sessionId ?? 'unexpected-fallback-id'
      }))
      const provider = createAgentClaimProvider({ spawn: daemonSpawn })
      const recoverFreshSpawnRouting = vi.fn(async () => {
        degraded = false
        return true
      })
      Object.defineProperties(provider, {
        routesFreshSpawnsToLocalProvider: {
          configurable: true,
          get: () => (degraded ? true : undefined)
        },
        recoverFreshSpawnRouting: { value: recoverFreshSpawnRouting }
      })
      setLocalPtyProvider(provider as never)
      const controller = registerAgentClaimController()
      const worktreeId = 'repo::/tmp/recovered-daemon-routing'
      const spawnArgs = {
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-daemon-routing',
        worktreeId
      }

      await (entryPoint === 'runtime controller'
        ? controller.spawn(spawnArgs)
        : handlers.get('pty:spawn')!(null, spawnArgs))

      expect(recoverFreshSpawnRouting).toHaveBeenCalledOnce()
      expect(daemonSpawn).toHaveBeenCalledOnce()
      expect(daemonSpawn.mock.calls[0]?.[0].sessionId).toMatch(
        new RegExp(`^${worktreeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@@`)
      )
      expect(recoverFreshSpawnRouting.mock.invocationCallOrder[0]).toBeLessThan(
        daemonSpawn.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
      )
    }
  )

  it('recovers degraded routing for a fresh runtime session with a stable id', async () => {
    let degraded = true
    const daemonSpawn = vi.fn(async (options: { sessionId?: string; isNewSession?: boolean }) => ({
      id: options.sessionId ?? 'unexpected-fallback-id'
    }))
    const provider = createAgentClaimProvider({ spawn: daemonSpawn })
    const recoverFreshSpawnRouting = vi.fn(async () => {
      degraded = false
      return true
    })
    Object.defineProperties(provider, {
      routesFreshSpawnsToLocalProvider: {
        configurable: true,
        get: () => (degraded ? true : undefined)
      },
      recoverFreshSpawnRouting: { value: recoverFreshSpawnRouting }
    })
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController()

    await controller.spawn({
      cols: 80,
      rows: 24,
      cwd: '/tmp/recovered-stable-session',
      worktreeId: 'repo::/tmp/recovered-stable-session',
      sessionId: 'serve-stable-session',
      isNewSession: true
    })

    expect(recoverFreshSpawnRouting).toHaveBeenCalledOnce()
    expect(daemonSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'serve-stable-session', isNewSession: true })
    )
  })

  it('adopts a daemon owner recovered from provider listing before claimed ensure', async () => {
    const owner: AgentSessionOwnerBinding = {
      claim: recoveredAgentClaim,
      generation: 'generation-recovered',
      phase: 'live',
      ptyId: 'pty-recovered-owner',
      surface: recoveredAgentSurface
    }
    const provider = createAgentClaimProvider({
      sessions: [
        {
          id: owner.ptyId,
          incarnationId: 'incarnation-recovered',
          cwd: '/tmp/recovered-worktree',
          title: 'Codex',
          agentSessionOwners: [owner]
        }
      ],
      livePtyIds: new Set([owner.ptyId])
    })
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController()

    const result = await controller.spawn({
      cols: 80,
      rows: 24,
      cwd: '/tmp/recovered-worktree',
      agentSessionEnsure: { claim: recoveredAgentClaim, surface: recoveredAgentSurface }
    })

    expect(result).toMatchObject({
      id: owner.ptyId,
      incarnationId: 'incarnation-recovered',
      agentSessionEnsure: { disposition: 'adopted', owner }
    })
    expect(isCurrentPtyExit({ id: owner.ptyId })).toBe(false)
    expect(isCurrentPtyExit({ id: owner.ptyId, incarnationId: 'incarnation-old' })).toBe(false)
    expect(isCurrentPtyExit({ id: owner.ptyId, incarnationId: 'incarnation-recovered' })).toBe(true)
    expect(provider.spawn).not.toHaveBeenCalled()
    clearProviderPtyState(owner.ptyId)
  })

  it('releases an adopted-owner fence when that owner exits during admission', async () => {
    const incarnationId = 'incarnation-adopted-exit'
    const owner: AgentSessionOwnerBinding = {
      claim: recoveredAgentClaim,
      generation: 'generation-adopted-exit',
      phase: 'live',
      ptyId: 'pty-adopted-exit',
      surface: recoveredAgentSurface
    }
    const runtime = new OrcaRuntimeService()
    const provider = createAgentClaimProvider({
      sessions: [
        {
          id: owner.ptyId,
          incarnationId,
          cwd: '/tmp/recovered-worktree',
          title: 'Codex',
          agentSessionOwners: [owner]
        }
      ],
      livePtyIds: new Set([owner.ptyId])
    })
    provider.listProcesses.mockImplementation(async () => {
      if (provider.listProcesses.mock.calls.length > 1) {
        runtime.onPtyExit(owner.ptyId, 0, incarnationId)
      }
      return [
        {
          id: owner.ptyId,
          incarnationId,
          cwd: '/tmp/recovered-worktree',
          title: 'Codex',
          agentSessionOwners: [owner]
        }
      ]
    })
    setLocalPtyProvider(provider as never)
    registerPtyHandlers(mainWindow as never, runtime)
    const controller = (
      runtime as unknown as {
        ptyController: { spawn(args: Record<string, unknown>): Promise<unknown> }
      }
    ).ptyController

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        agentSessionEnsure: { claim: recoveredAgentClaim, surface: recoveredAgentSurface }
      })
    ).rejects.toThrow('agent_session_exited_during_start')

    const internals = runtime as unknown as {
      earlyExitedPtyIncarnations: Map<string, string | null>
    }
    expect(internals.earlyExitedPtyIncarnations.has(owner.ptyId)).toBe(false)
  })

  it('rejects stale exits immediately after SSH reconnect restores an incarnation', () => {
    const ptyId = 'ssh:target-1@@pty-reconnected'
    restorePtyIncarnation(ptyId, 'incarnation-current')

    expect(isCurrentPtyExit({ id: ptyId, incarnationId: 'incarnation-old' })).toBe(false)
    expect(isCurrentPtyExit({ id: ptyId, incarnationId: 'incarnation-current' })).toBe(true)
    clearProviderPtyState(ptyId)
  })

  it('fails closed when a recovered claimed owner omits incarnation proof', async () => {
    const owner: AgentSessionOwnerBinding = {
      claim: {
        ...recoveredAgentClaim,
        identityDigest: '1212121212121212121212121212121212121212121'
      },
      generation: 'generation-no-incarnation',
      phase: 'live',
      ptyId: 'pty-owner-without-incarnation',
      surface: recoveredAgentSurface
    }
    const provider = createAgentClaimProvider({
      sessions: [
        {
          id: owner.ptyId,
          cwd: '/tmp/recovered-worktree',
          title: 'Codex',
          agentSessionOwners: [owner]
        }
      ]
    })
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController()

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        agentSessionEnsure: { claim: owner.claim, surface: recoveredAgentSurface }
      })
    ).rejects.toThrow('agent_session_ownership_unknown')
    expect(provider.spawn).not.toHaveBeenCalled()
  })

  it('fails closed without spawning when a recovered owner provider disconnects', async () => {
    const connectionId = 'ssh-agent-owner-gone'
    const ownerPtyId = `ssh:${connectionId}@@relay-owner`
    const claim = {
      ...recoveredAgentClaim,
      identityDigest: 'ccccccccccccccccccccccccccccccccccccccccccc'
    }
    const owner: AgentSessionOwnerBinding = {
      claim,
      generation: 'generation-remote',
      phase: 'live',
      ptyId: ownerPtyId,
      surface: recoveredAgentSurface
    }
    const remoteProvider = createAgentClaimProvider({
      sessions: [
        {
          id: ownerPtyId,
          incarnationId: 'incarnation-remote',
          cwd: '/tmp/recovered-worktree',
          title: 'Codex',
          agentSessionOwners: [owner]
        }
      ],
      livePtyIds: new Set([ownerPtyId])
    })
    registerSshPtyProvider(connectionId, remoteProvider as never)
    setLocalPtyProvider(createAgentClaimProvider({}) as never)
    const controller = registerAgentClaimController()

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        agentSessionEnsure: { claim, surface: recoveredAgentSurface }
      })
    ).resolves.toMatchObject({ id: ownerPtyId })

    unregisterSshPtyProvider(connectionId)
    const localSpawn = vi.fn(async () => ({ id: 'must-not-spawn' }))
    setLocalPtyProvider(createAgentClaimProvider({ spawn: localSpawn }) as never)

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        agentSessionEnsure: { claim, surface: recoveredAgentSurface }
      })
    ).rejects.toThrow('execution_owner_unavailable')
    expect(localSpawn).not.toHaveBeenCalled()
    clearProviderPtyState(ownerPtyId)
  })

  it('fails closed when provider listings disagree about a recovered claim owner', async () => {
    const claim = {
      ...recoveredAgentClaim,
      identityDigest: 'ddddddddddddddddddddddddddddddddddddddddddd'
    }
    const localOwner: AgentSessionOwnerBinding = {
      claim,
      generation: 'generation-conflict',
      phase: 'live',
      ptyId: 'pty-conflict-local',
      surface: recoveredAgentSurface
    }
    const remoteOwner: AgentSessionOwnerBinding = {
      ...localOwner,
      ptyId: 'ssh:ssh-agent-conflict@@pty-conflict-remote'
    }
    const localSpawn = vi.fn(async () => ({ id: 'must-not-spawn' }))
    setLocalPtyProvider(
      createAgentClaimProvider({
        sessions: [
          {
            id: localOwner.ptyId,
            incarnationId: 'incarnation-conflict-local',
            cwd: '/tmp/recovered-worktree',
            title: 'Codex',
            agentSessionOwners: [localOwner]
          }
        ],
        spawn: localSpawn
      }) as never
    )
    registerSshPtyProvider(
      'ssh-agent-conflict',
      createAgentClaimProvider({
        sessions: [
          {
            id: remoteOwner.ptyId,
            incarnationId: 'incarnation-conflict-remote',
            cwd: '/tmp/recovered-worktree',
            title: 'Codex',
            agentSessionOwners: [remoteOwner]
          }
        ]
      }) as never
    )
    const controller = registerAgentClaimController()

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        agentSessionEnsure: { claim, surface: recoveredAgentSurface }
      })
    ).rejects.toThrow('agent_session_conflict')
    expect(localSpawn).not.toHaveBeenCalled()

    unregisterSshPtyProvider('ssh-agent-conflict')
    clearProviderPtyState(localOwner.ptyId)
    clearProviderPtyState(remoteOwner.ptyId)
  })

  it('converges after conflicting listings shrink to one exact owner', async () => {
    const claim = {
      ...recoveredAgentClaim,
      identityDigest: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    }
    const ownerA: AgentSessionOwnerBinding = {
      claim,
      generation: 'generation-a',
      phase: 'live',
      ptyId: 'pty-conflict-a',
      surface: recoveredAgentSurface
    }
    const ownerB: AgentSessionOwnerBinding = {
      ...ownerA,
      generation: 'generation-b',
      ptyId: 'ssh:ssh-agent-converge@@pty-conflict-b'
    }
    const localSessions = [
      {
        id: ownerA.ptyId,
        incarnationId: 'incarnation-conflict-a',
        cwd: '/tmp/recovered-worktree',
        title: 'Codex',
        agentSessionOwners: [ownerA]
      }
    ]
    const remoteSessions = [
      {
        id: ownerB.ptyId,
        incarnationId: 'incarnation-conflict-b',
        cwd: '/tmp/recovered-worktree',
        title: 'Codex',
        agentSessionOwners: [ownerB]
      }
    ]
    const local = createAgentClaimProvider({ sessions: localSessions })
    setLocalPtyProvider(local as never)
    registerSshPtyProvider(
      'ssh-agent-converge',
      createAgentClaimProvider({ sessions: remoteSessions }) as never
    )
    const controller = registerAgentClaimController()
    const request = {
      cols: 80,
      rows: 24,
      cwd: '/tmp/recovered-worktree',
      agentSessionEnsure: { claim, surface: recoveredAgentSurface }
    }

    await expect(controller.spawn(request)).rejects.toThrow('agent_session_conflict')
    localSessions.splice(0)
    await expect(controller.spawn(request)).resolves.toMatchObject({
      id: ownerB.ptyId,
      agentSessionEnsure: { disposition: 'adopted', owner: ownerB }
    })
    expect(local.spawn).not.toHaveBeenCalled()

    unregisterSshPtyProvider('ssh-agent-converge')
    clearProviderPtyState(ownerA.ptyId)
    clearProviderPtyState(ownerB.ptyId)
  })

  it('does not adopt a stale generation when its PTY id is reused without ownership', async () => {
    const claim = {
      ...recoveredAgentClaim,
      identityDigest: 'fffffffffffffffffffffffffffffffffffffffffff'
    }
    const oldOwner: AgentSessionOwnerBinding = {
      claim,
      generation: 'generation-old',
      phase: 'live',
      ptyId: 'pty-reused',
      surface: recoveredAgentSurface
    }
    const sessions = [
      {
        id: oldOwner.ptyId,
        incarnationId: 'incarnation-old',
        cwd: '/tmp/recovered-worktree',
        title: 'Codex',
        agentSessionOwners: [oldOwner]
      }
    ]
    const spawn = vi.fn(
      async (options: {
        agentSessionEnsure?: { claim: typeof claim; surface: typeof recoveredAgentSurface }
      }) => {
        const ensured = options.agentSessionEnsure
        if (!ensured) {
          throw new Error('missing test claim')
        }
        const owner: AgentSessionOwnerBinding = {
          claim: ensured.claim,
          generation: 'generation-new',
          phase: 'live',
          ptyId: 'pty-new-owner',
          surface: ensured.surface
        }
        sessions.push({
          id: owner.ptyId,
          incarnationId: 'incarnation-new',
          cwd: '/tmp/recovered-worktree',
          title: 'Codex',
          agentSessionOwners: [owner]
        })
        return {
          id: owner.ptyId,
          agentSessionEnsure: { disposition: 'created' as const, owner }
        }
      }
    )
    const provider = createAgentClaimProvider({ sessions, spawn })
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController()
    const request = {
      cols: 80,
      rows: 24,
      cwd: '/tmp/recovered-worktree',
      agentSessionEnsure: { claim, surface: recoveredAgentSurface }
    }

    await expect(controller.spawn(request)).resolves.toMatchObject({ id: oldOwner.ptyId })
    sessions[0] = { ...sessions[0], agentSessionOwners: [] }
    await expect(controller.spawn(request)).resolves.toMatchObject({
      id: 'pty-new-owner',
      agentSessionEnsure: { disposition: 'created' }
    })
    expect(spawn).toHaveBeenCalledOnce()

    clearProviderPtyState(oldOwner.ptyId)
    clearProviderPtyState('pty-new-owner')
  })

  it('preserves an owner fence across disconnect and adopts it after reconnect', async () => {
    const connectionId = 'ssh-agent-reconnect'
    const claim = {
      ...recoveredAgentClaim,
      identityDigest: '9999999999999999999999999999999999999999999'
    }
    const owner: AgentSessionOwnerBinding = {
      claim,
      generation: 'generation-reconnect',
      phase: 'live',
      ptyId: `ssh:${connectionId}@@pty-owner`,
      surface: recoveredAgentSurface
    }
    const sessions = [
      {
        id: owner.ptyId,
        incarnationId: 'incarnation-reconnect',
        cwd: '/tmp/recovered-worktree',
        title: 'Codex',
        agentSessionOwners: [owner]
      }
    ]
    const firstProvider = createAgentClaimProvider({ sessions })
    setLocalPtyProvider(createAgentClaimProvider({}) as never)
    registerSshPtyProvider(connectionId, firstProvider as never)
    const controller = registerAgentClaimController()
    const request = {
      cols: 80,
      rows: 24,
      cwd: '/tmp/recovered-worktree',
      connectionId,
      agentSessionEnsure: { claim, surface: recoveredAgentSurface }
    }

    await expect(controller.spawn(request)).resolves.toMatchObject({ id: owner.ptyId })
    unregisterSshPtyProvider(connectionId)
    clearPtyOwnershipForConnection(connectionId)
    await expect(controller.spawn({ ...request, connectionId: undefined })).rejects.toThrow(
      'execution_owner_unavailable'
    )

    const reconnected = createAgentClaimProvider({ sessions })
    registerSshPtyProvider(connectionId, reconnected as never)
    await expect(controller.spawn(request)).resolves.toMatchObject({
      id: owner.ptyId,
      agentSessionEnsure: { disposition: 'adopted', owner }
    })
    expect(reconnected.spawn).not.toHaveBeenCalled()

    unregisterSshPtyProvider(connectionId)
    clearProviderPtyState(owner.ptyId)
  })

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
    // Why: the production handler sender-guards its destructive reconcile, so tests must present as the main window.
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

  function getMainFrameNavigationListener(): () => void {
    const listener = getMainWindowWebContentsListener('did-start-navigation')
    return () => listener({ isMainFrame: true, isSameDocument: false })
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
    getSelectedCodexHomePath?: (
      target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null },
      launchEnv?: NodeJS.ProcessEnv,
      launchContext?: { workspacePath?: string; launchAgent?: TuiAgent }
    ) => string | null,
    getSettings?: () => {
      enableGitHubAttribution?: boolean
      agentStatusHooksEnabled?: boolean
      httpProxyUrl?: string
      httpProxyBypassRules?: string
    },
    // Why: PR #2662 finding 2 — accept an optional `command` so callers can exercise OMP target resolution (was untested).
    command?: string,
    launchAgent?: TuiAgent,
    cwd?: string,
    worktreeId?: string
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
      // Clear previously registered handlers so re-registration doesn't accumulate stale state.
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
        ...(command ? { command } : {}),
        ...(launchAgent ? { launchAgent } : {}),
        ...(cwd ? { cwd } : {}),
        ...(worktreeId ? { worktreeId } : {})
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
      const env = await spawnAndGetEnv(undefined, undefined, () => TEST_CODEX_HOME)
      expect(env.CODEX_HOME).toBe(TEST_CODEX_HOME)
      expect(env.ORCA_CODEX_HOME).toBe(TEST_CODEX_HOME)
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

    describe('unverifiable Codex resume provenance', () => {
      const RESUME_SESSION_ID = '019f81b9-19a9-7651-a8d1-352d9420bd11'
      const ORIGIN_HOME = '/managed/origin/home'
      const OTHER_HOME = '/managed/other/home'
      const ORIGIN_ROLLOUT = `${ORIGIN_HOME}/sessions/2026/07/20/rollout-2026-07-20T12-00-00-${RESUME_SESSION_ID}.jsonl`

      // Why: main's real provenance rule via the same prepareCodexSessionResume that
      // index.ts calls, so the outcome wiring is exercised rather than restated. This
      // suite mocks fs, so the rollout is declared present — the only variable left is
      // whether its home is trusted, which is exactly the case the guard exists for.
      const prepareResumeWithTrustedHomes =
        (trustedHomes: readonly string[]): PrepareCodexSessionResume =>
        ({ providerSession }) =>
          prepareCodexSessionResume({
            sessionId: providerSession.id,
            transcriptPath: providerSession.transcriptPath,
            trustedCodexHomes: trustedHomes,
            // Why: these cases assert the argv drop, never the legacy rescan's home ranking
            // (#10801) — each passes a single trusted home, so no ranking can move the winner.
            getSelectedAccountCodexHome: () => null,
            systemCodexHomePath: null,
            sharedRuntimeCodexHomePath: null,
            fileIsRegular: () => true,
            resolveVerifiedResumeHome: async (source) => source.homePath
          })

      function registerWithTrustedHomes(trustedHomes: readonly string[], selectedHome: string) {
        const selectedHomeMock = vi.fn(() => selectedHome)
        registerPtyHandlers(
          mainWindow as never,
          undefined,
          selectedHomeMock,
          undefined,
          undefined,
          undefined,
          { prepareCodexSessionResume: prepareResumeWithTrustedHomes(trustedHomes) }
        )
        return selectedHomeMock
      }

      async function spawnCodexResume(
        transcriptPath: string | undefined,
        overrides: { command?: string; env?: Record<string, string> } = {}
      ): Promise<{ agentResumeUnavailable?: true }> {
        return (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp',
          command: overrides.command ?? `codex 'resume' '${RESUME_SESSION_ID}'`,
          ...(overrides.env ? { env: overrides.env } : {}),
          launchAgent: 'codex',
          resumeProviderSession: {
            key: 'session_id',
            id: RESUME_SESSION_ID,
            ...(transcriptPath ? { transcriptPath } : {})
          }
        })) as { agentResumeUnavailable?: true }
      }

      /** A daemon-shaped provider: the only local path that reports reattach results and
       *  the only one that surfaces the resolved spawn options this guard rewrites. */
      function setupResumeDaemonProvider(spawnResult: { isReattach?: true } = {}) {
        const daemonSpawn = vi.fn(
          async (options: {
            sessionId?: string
            command?: string
            env: Record<string, string>
          }) => {
            void options
            return { id: options.sessionId ?? 'daemon-pty', ...spawnResult }
          }
        )
        setLocalPtyProvider({
          spawn: daemonSpawn,
          supportsGitCredentialGuardHost: () => true,
          supportsAgentSessionClaims: () => true,
          supportsAgentSessionCreateOperations: () => true,
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

      posixOnlyIt(
        'launches plain codex when a REAL rollout sits under a home Orca no longer trusts',
        async () => {
          // Why: the discriminating case — the rollout exists, so only the trust check can
          // reject it. Falling through would resume it under the selected account.
          const mockProc = createMockProc()
          spawnMock.mockReturnValue(mockProc.proc)
          vi.useFakeTimers()

          try {
            const selectedHome = registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
            const spawned = await spawnCodexResume(ORIGIN_ROLLOUT)

            await Promise.resolve()
            vi.runAllTimers()
            await Promise.resolve()
            vi.runAllTimers()

            expect(mockProc.proc.write).toHaveBeenCalledWith('codex\n')
            expect(mockProc.proc.write).not.toHaveBeenCalledWith(
              expect.stringContaining(RESUME_SESSION_ID)
            )
            expect(spawned.agentResumeUnavailable).toBe(true)
            // The pane still runs under the selected account — but with nothing to resume.
            const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
            expect(env.CODEX_HOME).toBe(OTHER_HOME)
            expect(selectedHome).toHaveBeenCalled()
          } finally {
            vi.useRealTimers()
          }
        }
      )

      it('reports the dropped resume so the pane can say it started fresh', async () => {
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
        const spawned = await spawnCodexResume(ORIGIN_ROLLOUT)

        expect(spawned.agentResumeUnavailable).toBe(true)
      })

      it('stays silent for cross-agent provenance on a pane relabeled codex', async () => {
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

        const spawned = await spawnCodexResume(
          '/Users/example/.claude/projects/repo/019f81b9.jsonl'
        )

        expect(spawned.agentResumeUnavailable).toBeUndefined()
      })

      posixOnlyIt('still pins CODEX_HOME and resumes when provenance is verified', async () => {
        const mockProc = createMockProc()
        spawnMock.mockReturnValue(mockProc.proc)
        vi.useFakeTimers()

        try {
          const selectedHome = registerWithTrustedHomes([ORIGIN_HOME], OTHER_HOME)
          const spawned = await spawnCodexResume(ORIGIN_ROLLOUT)

          await Promise.resolve()
          vi.runAllTimers()
          await Promise.resolve()
          vi.runAllTimers()

          expect(mockProc.proc.write).toHaveBeenCalledWith(
            `codex 'resume' '${RESUME_SESSION_ID}'\n`
          )
          expect(spawned.agentResumeUnavailable).toBeUndefined()
          const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
          expect(env.CODEX_HOME).toBe(ORIGIN_HOME)
          expect(selectedHome).not.toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
        }
      })

      posixOnlyIt('reports a dropped resume that carried no transcript path at all', async () => {
        // Why: legacy sleeping-agent and relay records persist only the session id. The
        // argv still gets stripped, so silence would leave an empty pane unexplained.
        const mockProc = createMockProc()
        spawnMock.mockReturnValue(mockProc.proc)
        vi.useFakeTimers()

        try {
          registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
          const spawned = await spawnCodexResume(undefined)

          await Promise.resolve()
          vi.runAllTimers()
          await Promise.resolve()
          vi.runAllTimers()

          expect(mockProc.proc.write).toHaveBeenCalledWith('codex\n')
          expect(spawned.agentResumeUnavailable).toBe(true)
        } finally {
          vi.useRealTimers()
        }
      })

      it('refuses an unstrippable resume whose metadata claimed Codex layout', async () => {
        // Why: the locator survives in the command, so launching could still cross accounts.
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

        await expect(
          spawnCodexResume(ORIGIN_ROLLOUT, {
            command: `codex 'resume' '${RESUME_SESSION_ID}' --sandbox`
          })
        ).rejects.toThrow(/could not verify the originating Codex session file/)
      })

      posixOnlyIt(
        'launches an unstrippable resume unchanged when metadata never claimed Codex layout',
        async () => {
          // Why: a pane mislabeled "codex" carrying ~/.claude metadata launched fine before
          // this guard existed; refusing its spawn would be a new hard failure.
          const mockProc = createMockProc()
          spawnMock.mockReturnValue(mockProc.proc)
          vi.useFakeTimers()

          try {
            registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
            const command = `cd '/tmp/${RESUME_SESSION_ID}' && codex 'resume' '${RESUME_SESSION_ID}'`
            const spawned = await spawnCodexResume('/Users/example/.claude/projects/repo/x.jsonl', {
              command
            })

            await Promise.resolve()
            vi.runAllTimers()
            await Promise.resolve()
            vi.runAllTimers()

            expect(mockProc.proc.write).toHaveBeenCalledWith(`${command}\n`)
            expect(spawned.agentResumeUnavailable).toBeUndefined()
          } finally {
            vi.useRealTimers()
          }
        }
      )

      it('strips the resume argv from the sequenced startup command too', async () => {
        // Why: buildPtyHostEnv prefers this env var over the launch command and the
        // sequenced wrapper `eval`s it, so leaving it intact resumes under the wrong account.
        const daemonSpawn = setupResumeDaemonProvider()
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

        await spawnCodexResume(ORIGIN_ROLLOUT, {
          env: { ORCA_SEQUENCED_STARTUP_COMMAND: `codex 'resume' '${RESUME_SESSION_ID}'` }
        })

        const spawnOptions = daemonSpawn.mock.calls.at(-1)![0]
        expect(spawnOptions.env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe('codex')
        expect(spawnOptions.command).toBe('codex')
      })

      it('leaves the sequenced startup command alone when provenance is verified', async () => {
        const daemonSpawn = setupResumeDaemonProvider()
        registerWithTrustedHomes([ORIGIN_HOME], OTHER_HOME)
        const sequenced = `codex 'resume' '${RESUME_SESSION_ID}'`

        await spawnCodexResume(ORIGIN_ROLLOUT, {
          env: { ORCA_SEQUENCED_STARTUP_COMMAND: sequenced }
        })

        expect(daemonSpawn.mock.calls.at(-1)![0].env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe(sequenced)
      })

      posixOnlyIt(
        'strips the sequenced startup command on the local-provider spawn path too',
        async () => {
          // Why: the daemon branch is the only one that re-derives the spawn env from
          // baseEnv, so a local spawn is where a strip that lands on the wrong variable
          // silently survives — and the wrapper would `eval` the resume anyway.
          const mockProc = createMockProc()
          spawnMock.mockReturnValue(mockProc.proc)
          registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

          await spawnCodexResume(ORIGIN_ROLLOUT, {
            env: { ORCA_SEQUENCED_STARTUP_COMMAND: `codex 'resume' '${RESUME_SESSION_ID}'` }
          })

          const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
          expect(env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe('codex')
        }
      )

      posixOnlyIt(
        'leaves the local-provider sequenced startup command alone when provenance is verified',
        async () => {
          const mockProc = createMockProc()
          spawnMock.mockReturnValue(mockProc.proc)
          registerWithTrustedHomes([ORIGIN_HOME], OTHER_HOME)
          const sequenced = `codex 'resume' '${RESUME_SESSION_ID}'`

          await spawnCodexResume(ORIGIN_ROLLOUT, {
            env: { ORCA_SEQUENCED_STARTUP_COMMAND: sequenced }
          })

          const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
          expect(env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe(sequenced)
        }
      )

      it('omits the notice on a reattach that never ran this launch command', async () => {
        setupResumeDaemonProvider({ isReattach: true })
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

        const spawned = await spawnCodexResume(ORIGIN_ROLLOUT)

        expect(spawned.agentResumeUnavailable).toBeUndefined()
      })

      it('drops the resume argv on the runtime controller spawn path', async () => {
        // Why: the runtime/relay controller is a second spawn entry point; the invariant
        // has to hold there too even though it has no channel for the notice.
        const daemonSpawn = setupResumeDaemonProvider()
        const runtime = {
          setPtyController: vi.fn(),
          registerPty: vi.fn(),
          noteTerminalSpawnCommand: vi.fn(),
          onPtySpawned: vi.fn(),
          onPtyExit: vi.fn(),
          onPtyData: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(
          mainWindow as never,
          runtime as never,
          vi.fn(() => OTHER_HOME),
          undefined,
          undefined,
          undefined,
          { prepareCodexSessionResume: prepareResumeWithTrustedHomes([OTHER_HOME]) }
        )
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          spawn(args: Record<string, unknown>): Promise<{ id: string }>
        }

        await controller.spawn({
          cols: 80,
          rows: 24,
          command: `codex 'resume' '${RESUME_SESSION_ID}'`,
          env: { ORCA_SEQUENCED_STARTUP_COMMAND: `codex 'resume' '${RESUME_SESSION_ID}'` },
          launchAgent: 'codex',
          resumeProviderSession: {
            key: 'session_id',
            id: RESUME_SESSION_ID,
            transcriptPath: ORIGIN_ROLLOUT
          }
        })

        const spawnOptions = daemonSpawn.mock.calls.at(-1)![0]
        expect(spawnOptions.command).toBe('codex')
        expect(spawnOptions.env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe('codex')
        expect(runtime.noteTerminalSpawnCommand).toHaveBeenCalledWith(expect.any(String), 'codex')
      })
    })

    it('prepares Codex launch state for the workspace before spawning an interactive tab', async () => {
      const workspacePath = '/repo/worktrees/new-feature'
      const resolveHome = vi.fn(
        (
          _target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null },
          _launchEnv?: NodeJS.ProcessEnv,
          _launchContext?: { workspacePath?: string; launchAgent?: TuiAgent }
        ) => null
      )

      await spawnAndGetEnv(
        undefined,
        undefined,
        resolveHome,
        undefined,
        'codex',
        'codex',
        workspacePath,
        `repo-id::${workspacePath}`
      )

      expect(resolveHome.mock.calls[0]?.[0]).toEqual({ runtime: 'host' })
      expect(resolveHome.mock.calls[0]?.[2]).toEqual({ workspacePath, launchAgent: 'codex' })
      expect(resolveHome.mock.invocationCallOrder[0]).toBeLessThan(
        spawnMock.mock.invocationCallOrder[0]!
      )
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
        // Why: the reporter's app didn't inherit OPENCODE_CONFIG_DIR; their interactive zsh later exported a company config repo.
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
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/user-pi-agent',
        'pi',
        {
          materializeDefaultHome: false
        }
      )
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'omp', {
        materializeDefaultHome: false
      })
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/user-pi-agent')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/tmp/user-pi-agent')
      expect(env.ORCA_OMP_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(
        '/tmp/orca-user-data/omp-managed-status-extension/orca-agent-status.ts'
      )
      expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBeUndefined()
    })

    it('does not materialize a missing Pi home when another agent mentions Pi', async () => {
      const env = await spawnAndGetEnv(
        undefined,
        undefined,
        undefined,
        undefined,
        'codex "ask about pi"',
        'codex'
      )

      expect(piBuildPtyEnvMock).toHaveBeenCalledTimes(1)
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'pi', {
        materializeDefaultHome: false
      })
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
    })

    it('materializes Pi home for an explicit Pi launch through a custom command', async () => {
      const env = await spawnAndGetEnv(
        undefined,
        undefined,
        undefined,
        undefined,
        'custom-pi-wrapper',
        'pi'
      )

      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'pi', {
        materializeDefaultHome: true
      })
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/tmp/default-pi-agent')
    })

    it('threads command: "omp" through to piBuildPtyEnv and emits OMP status metadata', async () => {
      // Why: OMP launches emit ORCA_OMP_* shadow vars, not Pi-named ones; only PI_CODING_AGENT_DIR stays (OMP's own binary reads it).
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
        'omp',
        { materializeDefaultHome: true }
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
        'omp',
        { materializeDefaultHome: true }
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
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/user-pi-agent',
        'pi',
        {
          materializeDefaultHome: false
        }
      )
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

      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'omp', {
        materializeDefaultHome: true
      })
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

      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'pi', {
        materializeDefaultHome: true
      })
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
          'pi',
          { materializeDefaultHome: false }
        )
        expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/home/tester/.config/pi-agent')
      }
    )

    it('injects the agent hook receiver env into Orca terminal PTYs', async () => {
      const env = await spawnAndGetEnv()
      // Why: buildAgentHookEnv must run exactly once per local spawn (inside shared buildPtyHostEnv); the old ad-hoc double-call is gone.
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

    it('waits for managed Codex auth before spawning a local PTY', async () => {
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
      expect(spawnMock).not.toHaveBeenCalled()

      authReady = true
      await vi.advanceTimersByTimeAsync(25)
      await spawnPromise

      expect(spawnMock.mock.calls.at(-1)?.[2].env).toMatchObject({
        CODEX_HOME: TEST_CODEX_HOME,
        ORCA_CODEX_HOME: TEST_CODEX_HOME
      })
    })

    it('does not gate a bare local shell on managed Codex auth', async () => {
      readFileSyncMock.mockImplementation((filePath: string) => {
        if (filePath.endsWith('auth.json')) {
          throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
        }
        return ''
      })
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

      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledOnce()
    })

    it('leaves an inherited CODEX_HOME untouched for system default when the flag is OFF', async () => {
      // Why: flag OFF must stay byte-identical to today. With no managed home
      // selected (resolver null) and the real-home flag off, no CODEX_HOME
      // injection or strip happens; an inherited value survives as before.
      const env = await spawnAndGetEnv(
        undefined,
        { CODEX_HOME: '/tmp/system-codex-home' },
        () => null
      )
      expect(env.CODEX_HOME).toBe('/tmp/system-codex-home')
    })

    it('strips a nested-Orca override for system default when the real-home flag is ON', async () => {
      const env = await spawnAndGetEnv(
        { CODEX_HOME: '/managed/home', ORCA_CODEX_HOME: '/managed/home' },
        undefined,
        () => null,
        () => ({ codexSystemDefaultRealHomeEnabled: true }) as never
      )
      expect(env.CODEX_HOME).toBeUndefined()
      expect(env.ORCA_CODEX_HOME).toBeUndefined()
    })

    it('preserves a user-owned CODEX_HOME for system default when the real-home flag is ON', async () => {
      const env = await spawnAndGetEnv(
        { CODEX_HOME: '/home/me/.config/codex' },
        { ORCA_CODEX_HOME: undefined },
        () => null,
        () => ({ codexSystemDefaultRealHomeEnabled: true }) as never
      )
      expect(env.CODEX_HOME).toBe('/home/me/.config/codex')
      expect(env.ORCA_CODEX_HOME).toBeUndefined()
    })

    it('lets the resolver keep a per-spawn custom CODEX_HOME on the managed lane', async () => {
      const customHome = '/home/me/.config/codex'
      let resolvedCodexHome: string | undefined
      const resolveHome = vi.fn((_target: unknown, launchEnv?: NodeJS.ProcessEnv) => {
        resolvedCodexHome = launchEnv?.CODEX_HOME
        return launchEnv?.CODEX_HOME === customHome ? TEST_CODEX_HOME : null
      })

      const env = await spawnAndGetEnv(
        { CODEX_HOME: customHome },
        { CODEX_HOME: undefined, ORCA_CODEX_HOME: undefined },
        resolveHome,
        () => ({ codexSystemDefaultRealHomeEnabled: true }) as never
      )

      expect(resolveHome).toHaveBeenCalledTimes(1)
      expect(resolveHome.mock.calls[0]?.[0]).toEqual({ runtime: 'host' })
      expect(resolvedCodexHome).toBe(customHome)
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
      // Why: under the daemon, LocalPtyProvider.buildSpawnEnv never runs, so host-local env injection must happen in the pty:spawn handler instead.

      function setupDaemonAdapter(
        supportsGitCredentialGuardHost = true,
        reportedWslDistro?: string | null,
        supportsAgentSessionClaims = true,
        supportsAgentSessionCreateOperations = supportsAgentSessionClaims
      ) {
        const daemonSpawn = vi.fn(
          async (options: {
            env: Record<string, string>
            sessionId?: string
            isNewSession?: boolean
            agentSessionCreateOperationId?: string
            command?: string
          }) => ({
            id: options.sessionId ?? 'daemon-pty',
            ...(reportedWslDistro !== undefined ? { wslDistro: reportedWslDistro } : {})
          })
        )
        setLocalPtyProvider({
          spawn: daemonSpawn,
          supportsGitCredentialGuardHost: () => supportsGitCredentialGuardHost,
          supportsAgentSessionClaims: () => supportsAgentSessionClaims,
          supportsAgentSessionCreateOperations: () => supportsAgentSessionCreateOperations,
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
        getSelectedCodexHomePath?: (
          target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null },
          launchEnv?: NodeJS.ProcessEnv,
          launchContext?: { workspacePath?: string; launchAgent?: TuiAgent }
        ) => string | null,
        getSettings?: () => {
          enableGitHubAttribution?: boolean
          httpProxyUrl?: string
          httpProxyBypassRules?: string
        },
        processEnvOverrides?: Record<string, string | undefined>,
        // Why: daemon spawn tests exercise both WSL launch metadata from main and PR #2662 command threading for OMP.
        spawnArgs?: {
          cwd?: string
          worktreeId?: string
          shellOverride?: string
          command?: string
          launchAgent?: TuiAgent
          envToDelete?: string[]
        },
        supportsGitCredentialGuardHost = true
      ): Promise<DaemonSpawnCall> {
        const daemonSpawn = setupDaemonAdapter(supportsGitCredentialGuardHost)
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
        getSelectedCodexHomePath?: (
          target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null },
          launchEnv?: NodeJS.ProcessEnv,
          launchContext?: { workspacePath?: string; launchAgent?: TuiAgent }
        ) => string | null,
        getSettings?: () => {
          enableGitHubAttribution?: boolean
          httpProxyUrl?: string
          httpProxyBypassRules?: string
        },
        processEnvOverrides?: Record<string, string | undefined>,
        spawnArgs?: {
          cwd?: string
          shellOverride?: string
          command?: string
          launchAgent?: TuiAgent
        },
        supportsGitCredentialGuardHost = true
      ): Promise<Record<string, string>> {
        return (
          await daemonSpawnAndGetOptions(
            argsEnv,
            getSelectedCodexHomePath,
            getSettings,
            processEnvOverrides,
            spawnArgs,
            supportsGitCredentialGuardHost
          )
        ).env
      }

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

      it('materializes the full guard for a legacy daemon host', async () => {
        const env = await daemonSpawnAndGetEnv(
          {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.proxy',
            GIT_CONFIG_VALUE_0: 'http://proxy.invalid'
          },
          undefined,
          undefined,
          undefined,
          { command: 'claude' },
          false
        )

        expect(env.GIT_TERMINAL_PROMPT).toBe('0')
        expect(env.GCM_INTERACTIVE).toBe('never')
        expect(env.GIT_CONFIG_COUNT).toBe('3')
        expect(env.GIT_CONFIG_KEY_1).toBe('credential.interactive')
        expect(env.GIT_CONFIG_KEY_2).toBe('credential.guiPrompt')
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
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(sessionId, undefined, 'pi', {
          materializeDefaultHome: false
        })
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
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith('user-session-42', undefined, 'pi', {
          materializeDefaultHome: false
        })
      })

      it('prefixes a minted sessionId with the worktreeId when provided', async () => {
        // Why: daemon reconnect keys live-shell survival on the sessionId; prefixing with worktreeId scopes sessions by worktree with a unique tail.
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
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(sessionId, undefined, 'pi', {
          materializeDefaultHome: false
        })
      })

      it('reuses one attach-style daemon session for fresh-agent operation retries', async () => {
        const daemonSpawn = setupDaemonAdapter()
        let controller:
          | { spawn: (args: Record<string, unknown>) => Promise<{ id: string }> }
          | undefined
        const runtime = {
          setPtyController: vi.fn((next) => {
            controller = next
          }),
          registerPreAllocatedHandleForPty: vi.fn(),
          registerPty: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
        const request = {
          cols: 80,
          rows: 24,
          env: {},
          worktreeId: 'wt-alpha',
          agentSessionCreateOperationId: 'a'.repeat(43)
        }

        await controller!.spawn(request)
        await controller!.spawn(request)

        const first = daemonSpawn.mock.calls.at(-2)?.[0]
        const second = daemonSpawn.mock.calls.at(-1)?.[0]
        expect(first?.sessionId).toBe('wt-alpha@@aaaaaaaa')
        expect(second?.sessionId).toBe(first?.sessionId)
        expect(first?.isNewSession).toBe(true)
        expect(second?.isNewSession).toBe(true)
        expect(first?.agentSessionCreateOperationId).toBe('a'.repeat(43))
        expect(second?.agentSessionCreateOperationId).toBe('a'.repeat(43))
      })

      it('does not downgrade a structured claim after dispatch reaches an old daemon', async () => {
        const daemonSpawn = setupDaemonAdapter(true, undefined, false)
        let controller:
          | { spawn: (args: Record<string, unknown>) => Promise<{ id: string }> }
          | undefined
        const runtime = {
          setPtyController: vi.fn((next) => {
            controller = next
          }),
          registerPreAllocatedHandleForPty: vi.fn(),
          registerPty: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)

        await expect(
          controller!.spawn({
            cols: 80,
            rows: 24,
            worktreeId: recoveredAgentSurface.worktreeId,
            tabId: recoveredAgentSurface.tabId,
            leafId: recoveredAgentSurface.leafId,
            command: "codex resume 'provider-session-1'",
            agentSessionEnsure: {
              claim: recoveredAgentClaim,
              surface: recoveredAgentSurface
            }
          })
        ).rejects.toThrow('agent_session_claim_unavailable')

        expect(daemonSpawn).not.toHaveBeenCalled()
      })

      it('falls back to process.env.PI_CODING_AGENT_DIR when baseEnv lacks it on the daemon path', async () => {
        // Why: buildPtyHostEnv reads `baseEnv.X ?? process.env.X` so the agent-dir guard works whether Pi's env came over IPC or via daemon fork.
        const env = await daemonSpawnAndGetEnv({}, undefined, undefined, {
          PI_CODING_AGENT_DIR: '/ambient/pi/agent'
        })
        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
          expect.any(String),
          '/ambient/pi/agent',
          'pi',
          { materializeDefaultHome: false }
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
        // Why: the handler clones baseEnv so IPC-provided env stays pristine; a regression would leak Orca host env back into the renderer's reused copy.
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
        // Sanity: the spawn did receive the injected env, so the test isn't passing vacuously.
        const spawnEnv = daemonSpawn.mock.calls.at(-1)![0].env
        expect(spawnEnv.ORCA_AGENT_HOOK_PORT).toBe('5678')
        expect(spawnEnv).not.toBe(argsEnv)
      })

      it('rejects a caller-supplied sessionId that escapes userData via ..', async () => {
        // Why: effectiveSessionId reaches filesystem side-effects, so a traversal payload must be refused before they run.
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
        // Why: buildPtyHostEnv has filesystem side-effects, so a minted id's per-PTY state must be cleared if provider.spawn later fails.
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
        const runtime = {
          setPtyController: vi.fn(),
          createPreAllocatedTerminalHandle: vi.fn(() => null),
          preAllocateHandleForPty: vi.fn(),
          preparePtyExecutionContext: vi.fn().mockReturnValue(true)
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
        await expect(
          handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
        ).rejects.toThrow(/spawn boom/)
        expect(openCodeClearPtyMock).toHaveBeenCalled()
        expect(piClearPtyMock).toHaveBeenCalled()
        expect(runtime.preparePtyExecutionContext).toHaveBeenLastCalledWith(
          expect.any(String),
          null,
          { resetIncarnation: true }
        )
      })

      it('does NOT sweep per-PTY state on provider.spawn failure for CALLER-supplied sessionId', async () => {
        // Why: a caller-supplied sessionId may refer to an existing PTY whose state must survive a retry/attach failure; only minted ids get swept.
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
        const runtime = {
          setPtyController: vi.fn(),
          createPreAllocatedTerminalHandle: vi.fn(() => null),
          preAllocateHandleForPty: vi.fn(),
          preparePtyExecutionContext: vi.fn().mockReturnValue(true)
        }
        handlers.clear()
        registerPtyHandlers(mainWindow as never, runtime as never)
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
        expect(runtime.preparePtyExecutionContext).toHaveBeenLastCalledWith(
          'caller-owned-session',
          null,
          { resetIncarnation: true }
        )
      })

      it('does NOT inject host-local env on SSH spawns (connectionId set)', async () => {
        const sshSpawn = vi.fn(
          async (_opts: {
            env: Record<string, string>
            envToDelete?: string[]
            paneKey?: string
            tabId?: string
          }) => ({
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
            httpProxyBypassRules: 'localhost',
            codexSystemDefaultRealHomeEnabled: true
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
        // Why: host-local vars must be absent over SSH (they point at the local host/disk) — shipping them is useless or a credential leak.
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
        // Why: real-home routing is host-only. A null local-home resolver on
        // SSH must not become a request to alter the remote Codex environment.
        expect(spawnOptions.envToDelete ?? []).not.toContain('CODEX_HOME')
        expect(spawnOptions.envToDelete ?? []).not.toContain('ORCA_CODEX_HOME')
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
        expect(store.persistPtyBinding).toHaveBeenCalledWith(
          {
            worktreeId: 'wt-1',
            tabId: 'tab-1',
            leafId,
            ptyId: 'ssh-pty'
          },
          'ssh:ssh-1'
        )

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
          markSshRemotePtyLease: vi.fn(),
          retireLeaseAndReap: vi.fn(),
          clearSshRemotePtyLeaseReapFlag: vi.fn()
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
          markSshRemotePtyLease: vi.fn(),
          retireLeaseAndReap: vi.fn(),
          clearSshRemotePtyLeaseReapFlag: vi.fn()
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
          markSshRemotePtyLease: vi.fn(),
          retireLeaseAndReap: vi.fn(),
          clearSshRemotePtyLeaseReapFlag: vi.fn()
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
          retireLeaseAndReap: vi.fn(),
          clearSshRemotePtyLeaseReapFlag: vi.fn()
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
          retireLeaseAndReap: vi.fn(),
          clearSshRemotePtyLeaseReapFlag: vi.fn()
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
        expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', 0, undefined)
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
        expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', 0, undefined)
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
          retireLeaseAndReap: vi.fn(),
          clearSshRemotePtyLeaseReapFlag: vi.fn()
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
        expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', -1, undefined)
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

      it('does not accept an incarnation-less exit as proof that the current PTY stopped', async () => {
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

        expect(runtime.onPtyExit).toHaveBeenCalledWith('local-incarnated', -1, 'incarnation-live')
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
        const store = {
          markSshRemotePtyLease: vi.fn(),
          retireLeaseAndReap: vi.fn(),
          clearSshRemotePtyLeaseReapFlag: vi.fn()
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
        const store = {
          markSshRemotePtyLease: vi.fn(),
          retireLeaseAndReap: vi.fn(),
          clearSshRemotePtyLeaseReapFlag: vi.fn()
        }
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
        expect(runtime.onPtyExit).toHaveBeenCalledWith('ssh:ssh-1@@relay-pty', -1, undefined)
      })

      it('marks a detached SSH lease terminated when runtime controller kill has no provider', async () => {
        const store = {
          markSshRemotePtyLease: vi.fn(),
          retireLeaseAndReap: vi.fn(),
          clearSshRemotePtyLeaseReapFlag: vi.fn()
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
        expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', -1, undefined)
      })

      it('preserves an SSH lease when runtime controller kill shutdown fails transiently', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const store = {
          markSshRemotePtyLease: vi.fn(),
          retireLeaseAndReap: vi.fn(),
          clearSshRemotePtyLeaseReapFlag: vi.fn()
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
        expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', -1, undefined)
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

  it('routes runtime exact liveness without enumerating provider sessions', () => {
    const provider = getLocalPtyProvider()
    const hasPty = vi.spyOn(provider, 'hasPty').mockImplementation((id) => id === 'live-pty')
    const listProcesses = vi.spyOn(provider, 'listProcesses')
    const runtime = { setPtyController: vi.fn() }
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      hasPty: (ptyId: string) => boolean | null
    }

    expect(controller.hasPty('live-pty')).toBe(true)
    expect(controller.hasPty('missing-pty')).toBe(false)
    expect(hasPty).toHaveBeenCalledTimes(2)
    expect(listProcesses).not.toHaveBeenCalled()
  })

  it('scopes runtime inventories to the requested provider', async () => {
    const localList = vi
      .spyOn(getLocalPtyProvider(), 'listProcesses')
      .mockResolvedValue([{ id: 'local-pty', title: 'Local', cwd: '/local' }])
    const sshAList = vi.fn(async () => [{ id: 'ssh-a-pty' }])
    const sshBList = vi.fn(async () => {
      throw new Error('ssh-b unavailable')
    })
    registerSshPtyProvider('ssh-a', { listProcesses: sshAList } as never)
    registerSshPtyProvider('ssh-b', { listProcesses: sshBList } as never)
    const runtime = { setPtyController: vi.fn() }
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      listProcesses(connectionId?: string | null): Promise<{ id: string }[]>
    }

    await expect(controller.listProcesses(null)).resolves.toEqual([
      { id: 'local-pty', title: 'Local', cwd: '/local' }
    ])
    expect(localList).toHaveBeenCalledOnce()
    expect(sshAList).not.toHaveBeenCalled()
    expect(sshBList).not.toHaveBeenCalled()

    await expect(controller.listProcesses('ssh-a')).resolves.toEqual([{ id: 'ssh-a-pty' }])
    expect(sshAList).toHaveBeenCalledOnce()
    expect(sshBList).not.toHaveBeenCalled()

    await expect(controller.listProcesses()).rejects.toThrow('ssh-b unavailable')
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
    expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', -1, undefined)
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
    expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', 0, undefined)
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
    expect(runtime.onPtyExit).toHaveBeenCalledWith('local-pty', -1, undefined)
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

  // Why: cold-start teardown must select the daemon after startup, else fallback shutdown orphans the restored daemon PTY (#7742).
  it('waits for the desktop startup barrier before renderer local kills resolve the provider', async () => {
    const barrier = makeDeferred()
    const awaitLocalPtyStartup = vi.fn(() => new Promise<void>(() => {}))
    const awaitLocalPtyProviderStartup = vi.fn(() => barrier.promise)
    const fallbackShutdown = vi.spyOn(getLocalPtyProvider(), 'shutdown')
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        awaitLocalPtyStartup,
        awaitLocalPtyProviderStartup
      }
    )

    const daemonSessionId = 'wt-1@@11111111-1111-1111-1111-111111111111'
    const pendingKill = handlers.get('pty:kill')!(null, { id: daemonSessionId }) as Promise<void>

    await Promise.resolve()
    expect(awaitLocalPtyStartup).not.toHaveBeenCalled()
    expect(awaitLocalPtyProviderStartup).toHaveBeenCalledTimes(1)
    expect(fallbackShutdown).not.toHaveBeenCalled()
    const daemon = installObservableDaemonTestProvider()
    barrier.resolve()
    await pendingKill

    expect(daemon.spawn).not.toHaveBeenCalled()
    expect(daemon.shutdown).toHaveBeenCalledWith(
      daemonSessionId,
      expect.objectContaining({ immediate: true })
    )
    expect(fallbackShutdown).not.toHaveBeenCalled()
  })

  it('waits for the desktop startup barrier before runtime local kills resolve the provider', async () => {
    const barrier = makeDeferred()
    const awaitLocalPtyProviderStartup = vi.fn(() => barrier.promise)
    const fallbackShutdown = vi.spyOn(getLocalPtyProvider(), 'shutdown')
    const runtime = { setPtyController: vi.fn(), onPtyExit: vi.fn() }
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        awaitLocalPtyProviderStartup
      }
    )
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      kill: (ptyId: string) => boolean
    }

    expect(controller.kill('daemon-session')).toBe(true)
    await Promise.resolve()
    expect(awaitLocalPtyProviderStartup).toHaveBeenCalledTimes(1)
    expect(fallbackShutdown).not.toHaveBeenCalled()

    const daemon = installObservableDaemonTestProvider()
    barrier.resolve()
    await vi.waitFor(() => expect(daemon.shutdown).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(runtime.onPtyExit).toHaveBeenCalledTimes(1))

    expect(daemon.shutdown).toHaveBeenCalledWith('daemon-session', { immediate: false })
    expect(fallbackShutdown).not.toHaveBeenCalled()
  })

  it('waits for the desktop startup barrier before runtime exact stops resolve the provider', async () => {
    const barrier = makeDeferred()
    const awaitLocalPtyProviderStartup = vi.fn(() => barrier.promise)
    const fallbackShutdown = vi.spyOn(getLocalPtyProvider(), 'shutdown')
    const runtime = { setPtyController: vi.fn(), onPtyExit: vi.fn() }
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        awaitLocalPtyProviderStartup
      }
    )
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      stopAndWait: (ptyId: string) => Promise<boolean>
    }

    const pendingStop = controller.stopAndWait('daemon-session')
    await Promise.resolve()
    expect(awaitLocalPtyProviderStartup).toHaveBeenCalledTimes(1)
    expect(fallbackShutdown).not.toHaveBeenCalled()

    const daemon = installObservableDaemonTestProvider()
    barrier.resolve()
    await expect(pendingStop).resolves.toBe(true)

    expect(daemon.shutdown).toHaveBeenCalledWith('daemon-session', {
      immediate: true,
      keepHistory: false
    })
    expect(fallbackShutdown).not.toHaveBeenCalled()
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
        'daemon output'.length,
        undefined
      )
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: result.id,
        data: 'daemon output',
        seq: 13,
        rawLength: 'daemon output'.length
      })
      expect(runtime.onPtyExit).toHaveBeenCalledWith(result.id, 0, undefined)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:exit', {
        id: result.id,
        code: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the cap/flag must never fire in the common case (renderer keeps up), so small output carries no droppedBacklog.
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

  it('does not wait on the desktop startup barrier for SSH spawns or kills', async () => {
    const barrier = makeDeferred()
    const awaitLocalPtyStartup = vi.fn(() => barrier.promise)
    const sshSpawn = vi.fn(async () => ({ id: 'remote-pty' }))
    const sshShutdown = vi.fn()
    registerSshPtyProvider('ssh-1', {
      spawn: sshSpawn,
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: sshShutdown,
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
    await handlers.get('pty:kill')!(null, { id: 'remote-pty' })

    expect(awaitLocalPtyStartup).not.toHaveBeenCalled()
    expect(sshSpawn).toHaveBeenCalledTimes(1)
    expect(sshShutdown).toHaveBeenCalledWith('remote-pty', {
      immediate: true,
      keepHistory: false
    })
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

  it('starts local and SSH session inventories concurrently', async () => {
    let resolveLocal!: (sessions: { id: string; cwd: string; title: string }[]) => void
    const localSessions = new Promise<{ id: string; cwd: string; title: string }[]>((resolve) => {
      resolveLocal = resolve
    })
    vi.spyOn(getLocalPtyProvider(), 'listProcesses').mockReturnValue(localSessions)
    registerPtyHandlers(mainWindow as never)

    let resolveSsh!: (sessions: { id: string; cwd: string; title: string }[]) => void
    const sshSessions = new Promise<{ id: string; cwd: string; title: string }[]>((resolve) => {
      resolveSsh = resolve
    })
    const sshListProcesses = vi.fn(() => sshSessions)
    registerSshPtyProvider('ssh-1', {
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
      onExit: vi.fn(() => () => {}),
      listProcesses: sshListProcesses,
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    const pendingInventory = handlers.get('pty:listSessions')!(null, undefined)

    expect(sshListProcesses).toHaveBeenCalledTimes(1)
    resolveLocal([])
    resolveSsh([])
    await pendingInventory
  })

  it('reports authoritative snapshot capability with the owning provider context', async () => {
    const capabilityProvider = {
      authoritativeIds: new Set(['current-pty']),
      canProvideAuthoritativeBufferSnapshot(id: string) {
        return this.authoritativeIds.has(id)
      }
    }
    registerPtyHandlers(mainWindow as never)
    setLocalPtyProvider(capabilityProvider as never)
    const result = await handlers.get('pty:getAuthoritativeBufferSnapshotCapabilities')?.(null, {
      ids: ['current-pty', 'legacy-pty', 'current-pty', 42]
    })

    expect(result).toEqual([
      { id: 'current-pty', authoritative: true },
      { id: 'legacy-pty', authoritative: false }
    ])
  })

  it('waits for local provider startup before resolving snapshot capability', async () => {
    const barrier = makeDeferred()
    const awaitLocalPtyProviderStartup = vi.fn(() => barrier.promise)
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { awaitLocalPtyProviderStartup }
    )
    const pending = Promise.resolve(
      handlers.get('pty:getAuthoritativeBufferSnapshotCapabilities')?.(null, {
        ids: ['restored-local-pty']
      })
    )
    let settled = false
    void pending.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(awaitLocalPtyProviderStartup).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)

    installDaemonTestProvider({ canProvideAuthoritativeBufferSnapshot: () => true })
    barrier.resolve()

    await expect(pending).resolves.toEqual([{ id: 'restored-local-pty', authoritative: true }])
  })

  it('does not gate remote snapshot capability on local provider startup', async () => {
    const awaitLocalPtyProviderStartup = vi.fn(() => new Promise<void>(() => {}))
    registerSshPtyProvider('ssh-1', {
      canProvideAuthoritativeBufferSnapshot: () => false
    } as never)
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { awaitLocalPtyProviderStartup }
    )

    const result = await handlers.get('pty:getAuthoritativeBufferSnapshotCapabilities')?.(null, {
      ids: ['remote:environment@@pty-1', 'ssh:ssh-1@@pty-2']
    })

    expect(awaitLocalPtyProviderStartup).not.toHaveBeenCalled()
    expect(result).toEqual([
      { id: 'remote:environment@@pty-1', authoritative: false },
      { id: 'ssh:ssh-1@@pty-2', authoritative: false }
    ])
  })

  it('answers false, not null, for a resolved provider with no snapshot capability', async () => {
    // Null is never cached, so missing optional methods must resolve false.
    registerPtyHandlers(mainWindow as never)
    setLocalPtyProvider({ spawn: vi.fn(), write: vi.fn() } as never)

    const result = await handlers.get('pty:getAuthoritativeBufferSnapshotCapabilities')?.(null, {
      ids: ['local-pty']
    })

    expect(result).toEqual([{ id: 'local-pty', authoritative: false }])
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

  it('never answers liveness for a paired-runtime handle from the local registry', async () => {
    const hasPty = vi.fn(() => false)
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
    registerPtyHandlers(mainWindow as never)

    // The local provider would happily report `false` here — it just doesn't
    // hold the id. Callers read that as "the shell died" (STA-2830).
    await expect(
      handlers.get('pty:hasPty')!(null, { id: 'remote:env-1@@terminal-1' })
    ).resolves.toBe(null)
    expect(hasPty).not.toHaveBeenCalled()
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

  it('reports agent ownership through pty:listSessions so the renderer cannot guess it', async () => {
    registerPtyHandlers(mainWindow as never)
    // Why: the renderer's binding map is empty during restore, so agent ownership is the only
    // positive liveness evidence it has. Dropping it here force-killed live sessions (#8459).
    const owner = {
      claim: {
        digestVersion: AGENT_SESSION_CLAIM_DIGEST_VERSION,
        keyId: 'key-1',
        identityDigest: 'a'.repeat(43),
        worktreeScopeDigest: 'b'.repeat(43),
        agent: 'codex'
      },
      generation: 'gen-1',
      phase: 'live',
      ptyId: 'agent-pty',
      surface: {
        worktreeId: 'repo::/workspace',
        tabId: 'tab',
        leafId: '11111111-1111-4111-8111-111111111111',
        terminalHandle: 'term_claimed'
      }
    }
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
      listProcesses: vi.fn(async () => [
        { id: 'agent-pty', cwd: '/workspace', title: 'codex', agentSessionOwners: [owner] },
        { id: 'plain-pty', cwd: '/tmp', title: 'zsh' }
      ]),
      // Why: this provider serializes claims, so its silence about an owner is authoritative.
      providesAgentSessionOwnerListings: () => true,
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    const sessions = (await handlers.get('pty:listSessions')!(null, undefined)) as {
      id: string
      agentOwnership: string
    }[]

    expect(sessions.find((s) => s.id === 'agent-pty')?.agentOwnership).toBe('present')
    expect(sessions.find((s) => s.id === 'plain-pty')?.agentOwnership).toBe('absent')
  })

  it('reports unknown ownership when the provider cannot serialize claims', async () => {
    registerPtyHandlers(mainWindow as never)
    // Why: a legacy daemon generation or older SSH relay lists no owners for a session that may
    // have one. Reporting that silence as 'absent' is what let live agent sessions be killed (#8459).
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
      listProcesses: vi.fn(async () => [{ id: 'legacy-pty', cwd: '/workspace', title: 'zsh' }]),
      providesAgentSessionOwnerListings: () => false,
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    const sessions = (await handlers.get('pty:listSessions')!(null, undefined)) as {
      id: string
      agentOwnership: string
    }[]

    expect(sessions.find((s) => s.id === 'legacy-pty')?.agentOwnership).toBe('unknown')
  })

  const makeSshKillStore = (): {
    markSshRemotePtyLease: ReturnType<typeof vi.fn>
    retireLeaseAndReap: ReturnType<typeof vi.fn>
    clearSshRemotePtyLeaseReapFlag: ReturnType<typeof vi.fn>
  } => ({
    markSshRemotePtyLease: vi.fn(),
    retireLeaseAndReap: vi.fn(),
    clearSshRemotePtyLeaseReapFlag: vi.fn()
  })

  const registerSshKillProvider = (connectionId: string, shutdown: () => Promise<void>): void => {
    registerSshPtyProvider(connectionId, {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown,
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
  }

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
    const store = {
      markSshRemotePtyLease: vi.fn(),
      retireLeaseAndReap: vi.fn(),
      clearSshRemotePtyLeaseReapFlag: vi.fn()
    }
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
    // D4 — a successful kill leaves nothing for the next connect's reap drain to chase.
    expect(store.clearSshRemotePtyLeaseReapFlag).toHaveBeenCalledWith('ssh-1', 'relay-pty')
  })

  it('records the close intent before the RPC so a wedged relay cannot resurrect the pane', async () => {
    const store = makeSshKillStore()
    // Why: CONNECTION_LOST is what a frozen relay actually rejects with, and it is not "already gone",
    // so the handler rethrows and never reaches finishPtyShutdown — RC5's window.
    registerSshKillProvider(
      'ssh-1',
      vi.fn(async () => {
        throw new Error('SSH connection lost, reconnecting...')
      })
    )
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      store as never
    )

    await expect(handlers.get('pty:kill')!(null, { id: 'ssh:ssh-1@@relay-pty' })).rejects.toThrow(
      'SSH connection lost'
    )

    expect(store.retireLeaseAndReap).toHaveBeenCalledWith(
      'ssh-1',
      'relay-pty',
      'pty kill requested'
    )
    // The retry the rethrow preserves must not un-retire the lease, and the remote shell is D3's now.
    expect(store.clearSshRemotePtyLeaseReapFlag).not.toHaveBeenCalled()
    expect(store.markSshRemotePtyLease).not.toHaveBeenCalled()
  })

  it('retires the lease on an already-gone SSH PTY without leaving a reap flag behind', async () => {
    const store = makeSshKillStore()
    registerSshKillProvider(
      'ssh-1',
      vi.fn(async () => {
        throw new Error('PTY "relay-pty" not found')
      })
    )
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      store as never
    )

    await expect(
      handlers.get('pty:kill')!(null, { id: 'ssh:ssh-1@@relay-pty' })
    ).resolves.toBeUndefined()

    expect(store.retireLeaseAndReap).toHaveBeenCalledWith(
      'ssh-1',
      'relay-pty',
      'pty kill requested'
    )
    expect(store.clearSshRemotePtyLeaseReapFlag).toHaveBeenCalledWith('ssh-1', 'relay-pty')
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
    const store = {
      markSshRemotePtyLease: vi.fn(),
      retireLeaseAndReap: vi.fn(),
      clearSshRemotePtyLeaseReapFlag: vi.fn()
    }
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
    // D4 — no RPC can reach the relay here, so the flag is the only path to killing the remote
    // shell; the flag must survive (no clear), or the next connect's drain has nothing to honour.
    expect(store.retireLeaseAndReap).toHaveBeenCalledWith(
      'ssh-1',
      'relay-pty',
      'pty kill requested while disconnected'
    )
    expect(store.clearSshRemotePtyLeaseReapFlag).not.toHaveBeenCalled()
  })

  it('ignores fire-and-forget IPC for detached SSH PTYs without a provider', async () => {
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(),
      markSshRemotePtyLease: vi.fn(),
      retireLeaseAndReap: vi.fn(),
      clearSshRemotePtyLeaseReapFlag: vi.fn()
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

  it('preserves unavailable process inspection results from the provider', async () => {
    const inspectProcess = vi.fn(async () => ({
      foregroundProcess: null,
      hasChildProcesses: true,
      unavailable: true as const
    }))
    registerPtyHandlers(mainWindow as never)
    setLocalPtyProvider({ inspectProcess } as never)

    await expect(
      handlers.get('pty:inspectProcess')!(null, { id: 'legacy-daemon-pty' })
    ).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: true,
      unavailable: true
    })
  })

  it('settles a stale renderer process inspection as unavailable', async () => {
    registerPtyHandlers(mainWindow as never)
    setLocalPtyProvider({ hasPty: vi.fn(() => false) } as never)

    await expect(handlers.get('pty:inspectProcess')!(null, { id: 'gone-pty' })).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: false,
      unavailable: true
    })
  })

  // Why: daemon resize is fire-and-forget, so pty:getSize must report the APPLIED size, not the requested one (Claude-Code split-pane desync).
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
      // The daemon keeps the PTY at its wide spawn size; the narrow resize is silently dropped (fire-and-forget).
      setupProviderWithAppliedSize({ applied: { cols: 200, rows: 50 } })
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 200, rows: 50, env: {} })
      const id = (spawn as { id: string }).id

      // Renderer forwards a corrective narrow resize; it is dropped daemon-side.
      resizeListener()(mainWindowIpcEvent, { id, cols: 80, rows: 24 })

      // getSize must surface the applied wide size so the renderer detects drift and re-asserts — NOT requested 80.
      const reported = await handlers.get('pty:getSize')!(null, { id })
      expect(reported).toEqual({ cols: 200, rows: 50 })
    })

    it('falls back to the requested size when the provider cannot report applied size', async () => {
      // No getAppliedSize (e.g. SSH relay): requested-size cache is the only signal, so getSize returns it.
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

    it('preserves provider-owned null so the renderer re-forwards an unverified size', async () => {
      setupProviderWithAppliedSize({ applied: null, getAppliedSize: async () => null })
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 100, rows: 30, env: {} })
      const id = (spawn as { id: string }).id
      resizeListener()(mainWindowIpcEvent, { id, cols: 80, rows: 24 })

      const reported = await handlers.get('pty:getSize')!(null, { id })
      expect(reported).toBeNull()
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
        // The fix: a PTY with a remote viewer reports true even though driver state stays idle/desktop.
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

    // Why: #7587 — the runtime can only back a stalled mobile create if the spawn threads {tabId, leafId}.
    expect(runtime.registerPty).toHaveBeenCalledWith(
      expect.any(String),
      'wt-1',
      null,
      { tabId: 'tab-1', leafId, incarnationId: expect.any(String) },
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

    // Why: legacy numeric pane ids (`pane:N`) aren't leaf ids, so the seam passes a clean `undefined` (no fabricated binding).
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
    const spawned = await spawnController.spawn({
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
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:spawned', {
      id: spawned.id
    })
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
      ptyId: expect.any(String),
      incarnationId: expect.any(String)
    })
  })

  it('reports lower-owner commit before rejecting an early-exited runtime incarnation', async () => {
    const persistPtyBinding = vi.fn()
    const onPtySpawnCommitted = vi.fn()
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
        terminalMainSideEffectAuthority: true
      }),
      persistPtyBinding
    } as never)
    const provider = createAgentClaimProvider({
      spawn: vi.fn(async () => {
        runtime.onPtySpawned('pty-early-exit', 'incarnation-early-exit')
        runtime.onPtyExit('pty-early-exit', 0, 'incarnation-early-exit')
        return {
          id: 'pty-early-exit',
          incarnationId: 'incarnation-early-exit',
          providerSequence: { value: 17, generation: 'reset' as const },
          wslDistro: 'Ubuntu'
        }
      }),
      authoritativeOwnerListings: false
    })
    setLocalPtyProvider(provider as never)
    registerPtyHandlers(mainWindow as never, runtime, undefined, undefined, undefined, {
      persistPtyBinding
    } as never)
    const controller = (
      runtime as unknown as {
        ptyController: {
          spawn(args: Record<string, unknown>): Promise<unknown>
        }
      }
    ).ptyController
    const tabId = '11111111-1111-4111-8111-111111111111'
    const leafId = '22222222-2222-4222-8222-222222222222'

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        worktreeId: 'repo::/tmp/worktree',
        tabId,
        leafId,
        preAllocatedHandle: 'term_early_exit',
        persistHostSessionBinding: true,
        onPtySpawnCommitted
      })
    ).rejects.toThrow('agent_session_exited_during_start')

    expect(onPtySpawnCommitted).toHaveBeenCalledOnce()
    expect(persistPtyBinding).not.toHaveBeenCalled()
    const internals = runtime as unknown as {
      handleByPtyId: Map<string, string>
      providerSequenceInitializedPtys: Set<string>
      ptyOutputSequenceById: Map<string, number>
      ptysById: Map<string, { connected: boolean }>
      wslDistroByPtyId: Map<string, string>
      earlyExitedPtyIncarnations: Map<string, string | null>
    }
    expect(internals.handleByPtyId.has('pty-early-exit')).toBe(false)
    expect(internals.providerSequenceInitializedPtys.has('pty-early-exit')).toBe(false)
    expect(internals.ptyOutputSequenceById.has('pty-early-exit')).toBe(false)
    expect(internals.ptysById.get('pty-early-exit')?.connected).not.toBe(true)
    expect(internals.wslDistroByPtyId.has('pty-early-exit')).toBe(false)
    expect(internals.earlyExitedPtyIncarnations.has('pty-early-exit')).toBe(false)
    clearProviderPtyState('pty-early-exit')
  })

  it('does not retain a claimed owner when its PTY exits before controller admission', async () => {
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
        terminalMainSideEffectAuthority: true
      })
    } as never)
    const sessions: {
      id: string
      incarnationId: string
      cwd: string
      title: string
    }[] = []
    let attempt = 0
    const physicalSpawn = vi.fn(async () => {
      attempt += 1
      const incarnationId = attempt === 1 ? 'incarnation-exited' : 'incarnation-live'
      if (attempt === 1) {
        runtime.onPtySpawned('pty-claimed-admission', incarnationId)
        runtime.onPtyExit('pty-claimed-admission', 0, incarnationId)
      } else {
        sessions.push({
          id: 'pty-claimed-admission',
          incarnationId,
          cwd: '/tmp/worktree',
          title: 'Codex'
        })
      }
      return { id: 'pty-claimed-admission', incarnationId }
    })
    const provider = createAgentClaimProvider({
      sessions,
      spawn: physicalSpawn,
      authoritativeOwnerListings: false
    })
    Object.assign(provider, { routesFreshSpawnsToLocalProvider: true })
    setLocalPtyProvider(provider as never)
    registerPtyHandlers(mainWindow as never, runtime)
    const controller = (
      runtime as unknown as {
        ptyController: { spawn(args: Record<string, unknown>): Promise<unknown> }
      }
    ).ptyController
    const request = {
      cols: 80,
      rows: 24,
      cwd: '/tmp/worktree',
      agentSessionEnsure: {
        claim: recoveredAgentClaim,
        surface: recoveredAgentSurface
      }
    }

    await expect(controller.spawn(request)).rejects.toThrow('agent_session_exited_during_start')
    expect(
      isCurrentPtyExit({
        id: 'pty-claimed-admission',
        incarnationId: 'unrelated-incarnation'
      })
    ).toBe(true)
    await expect(controller.spawn(request)).resolves.toMatchObject({
      id: 'pty-claimed-admission',
      agentSessionEnsure: { disposition: 'created' }
    })
    expect(physicalSpawn).toHaveBeenCalledTimes(2)
    clearProviderPtyState('pty-claimed-admission')
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

    // Why: SSH can strip ORCA_PANE_KEY before spawn; tab/leaf metadata must still dedupe against runtime materialization.
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
      { id: 'pty-shared', isReattach: true }
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

  it('waits for an early runtime pane claim before renderer creation', async () => {
    type RuntimeSpawnController = {
      claimStablePaneCreate(args: {
        worktreeId: string
        connectionId: string | null
        tabId: string
        leafId: string
      }): () => void
    }
    const providerSpawn = vi.fn(async () => ({ id: 'pty-after-runtime-claim' }))
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
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_claimed'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    const tabId = 'tab-early-runtime-claim'
    const leafId = '44444444-4444-4444-8444-444444444444'
    const worktreeId = 'repo-1::/tmp/early-runtime-claim'
    const releaseClaim = (controller as unknown as RuntimeSpawnController).claimStablePaneCreate({
      worktreeId,
      connectionId: null,
      tabId,
      leafId
    })

    const mounted = handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp/early-runtime-claim',
      worktreeId,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: makePaneKey(tabId, leafId),
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: worktreeId
      }
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(providerSpawn).not.toHaveBeenCalled()

    releaseClaim()
    await expect(mounted).resolves.toMatchObject({ id: 'pty-after-runtime-claim' })
    expect(providerSpawn).toHaveBeenCalledOnce()
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
    let registeredPane: { ptyId: string; tabId: string; leafId: string } | null = null
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_trusted'),
      preAllocateHandleForPty: vi.fn(() => 'term_trusted'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(
        (
          ptyId: string,
          _worktreeId: string,
          _connectionId: string | null,
          binding?: { tabId: string; leafId: string }
        ) => {
          if (binding) {
            registeredPane = { ptyId, ...binding }
          }
        }
      ),
      resolveTerminalPane: vi.fn(() => {
        if (!registeredPane) {
          throw new Error('terminal_not_found')
        }
        return {
          handle: 'term_trusted',
          tabId: registeredPane.tabId,
          leafId: registeredPane.leafId,
          ptyId: registeredPane.ptyId,
          worktreeId: 'repo-1::/tmp'
        }
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
    await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledTimes(1))
    resolveSpawn({ id: 'pty-renderer' })
    const [rendererResult, runtimeResult] = await Promise.all([rendererSpawn, runtimeSpawn])
    expect(rendererResult).toEqual({ id: 'pty-renderer' })
    expect(runtimeResult).toEqual({
      id: 'pty-renderer',
      stablePaneOwner: {
        handle: 'term_trusted',
        tabId: 'tab-race',
        leafId
      }
    })
    expect(providerSpawn).toHaveBeenCalledTimes(1)
    expect(store.persistPtyBinding).toHaveBeenCalledWith({
      worktreeId: 'repo-1::/tmp',
      tabId: 'tab-race',
      leafId,
      ptyId: 'pty-renderer',
      startupCwd: '/tmp'
    })
  })

  it.each([
    {
      label: 'git worktree',
      worktreeId: 'repo-1::/tmp/live-owner',
      cwd: '/tmp/live-owner'
    },
    {
      label: 'folder workspace',
      worktreeId: 'folder:live-owner',
      cwd: '/tmp'
    }
  ])(
    'adopts a completed runtime-owned pane before replacement launch preflight ($label)',
    async ({ worktreeId, cwd }) => {
      type StableAdoption = {
        result: { id: string; incarnationId?: string; isReattach?: boolean }
        owner: { handle?: string; tabId: string; leafId: string; ptyId: string }
        materialized?: true
      } | null
      type RuntimeSpawnController = {
        adoptStablePane(args: {
          cols: number
          rows: number
          worktreeId: string
          tabId: string
          leafId: string
          cwd: string
        }): Promise<StableAdoption>
        spawn(args: Record<string, unknown>): Promise<{
          id: string
          incarnationId?: string
          stablePaneOwner?: { handle: string; tabId: string; leafId: string }
        }>
      }
      const tabId = 'tab-live-owner'
      const leafId = '66666666-6666-4666-8666-666666666666'
      const paneKey = makePaneKey(tabId, leafId)
      let ownerPublished = false
      let releaseAttach!: () => void
      let attachBarrier: Promise<void>
      const resetAttachBarrier = (): void => {
        attachBarrier = new Promise<void>((resolve) => {
          releaseAttach = resolve
        })
      }
      resetAttachBarrier()
      const supportsAgentSessionClaims = vi.fn(async () => false)
      const supportsAgentSessionCreateOperations = vi.fn(async () => false)
      const providerSpawn = vi.fn(
        async (options: { attachOnly?: boolean; command?: string; sessionId?: string }) => {
          if (options.attachOnly) {
            await attachBarrier
            return {
              id: 'pty-live-owner',
              incarnationId: 'inc-live-owner',
              isReattach: true,
              snapshot: 'original-live-output',
              providerSequence: { value: 20, generation: 'continued' as const }
            }
          }
          return { id: 'pty-live-owner', incarnationId: 'inc-live-owner' }
        }
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
        supportsAgentSessionClaims,
        supportsAgentSessionCreateOperations,
        attach: vi.fn(),
        getDefaultShell: vi.fn(),
        getProfiles: vi.fn()
      } as never)
      const folderWorkspace = {
        id: 'live-owner',
        folderPath: cwd,
        projectGroupId: 'folder-group'
      }
      const store = {
        persistPtyBinding: vi.fn(),
        getFolderWorkspace: vi.fn(() => folderWorkspace),
        getFolderWorkspaces: vi.fn(() => [folderWorkspace]),
        getProjectGroups: vi.fn(() => []),
        getRepos: vi.fn(() => [])
      }
      const prepareClaudeAuth = vi.fn(() => {
        throw new Error('replacement auth preflight must not run')
      })
      let controller: RuntimeSpawnController | null = null
      const runtime = {
        setPtyController: vi.fn((value) => {
          controller = value
        }),
        resolveTerminalPane: vi.fn(() => {
          if (!ownerPublished) {
            throw new Error('terminal_not_found')
          }
          return {
            handle: 'term-live-owner',
            tabId,
            leafId,
            ptyId: 'pty-live-owner',
            worktreeId
          }
        }),
        createPreAllocatedTerminalHandle: vi.fn(() => 'term-provisional-renderer'),
        preAllocateHandleForPty: vi.fn(() => 'term-live-owner'),
        registerPreAllocatedHandleForPty: vi.fn(),
        beginPtyRegistration: vi.fn(),
        cancelPendingPtyRegistration: vi.fn(),
        assertPtyRegistrationAllowed: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        seedHeadlessTerminal: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn()
      }

      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        prepareClaudeAuth,
        store as never
      )
      const spawnController = controller as unknown as RuntimeSpawnController
      await spawnController.spawn({
        cols: 80,
        rows: 24,
        cwd,
        command: 'node original-agent-fixture.mjs',
        worktreeId,
        preAllocatedHandle: 'term-live-owner',
        tabId,
        leafId,
        env: { ORCA_PANE_KEY: paneKey },
        persistHostSessionBinding: true
      })
      ownerPublished = true
      runtime.createPreAllocatedTerminalHandle.mockClear()
      runtime.registerPreAllocatedHandleForPty.mockClear()
      runtime.noteTerminalSpawnCommand.mockClear()
      trackMock.mockClear()
      store.persistPtyBinding.mockClear()
      mainWindow.webContents.send.mockClear()

      const mountArgs = {
        cols: 120,
        rows: 40,
        cwd,
        command: 'claude --resume provider-session',
        launchAgent: 'claude',
        worktreeId,
        tabId,
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: worktreeId
        },
        telemetry: {
          agent_kind: 'codex',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        }
      }
      const firstMount = handlers.get('pty:spawn')!(null, mountArgs)
      await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledTimes(2))
      const secondMount = handlers.get('pty:spawn')!(null, mountArgs)
      releaseAttach()
      const [mounted, concurrentMounted] = await Promise.all([firstMount, secondMount])

      expect(mounted).toMatchObject({
        id: 'pty-live-owner',
        incarnationId: 'inc-live-owner',
        isReattach: true,
        snapshot: 'original-live-output'
      })
      expect(concurrentMounted).toEqual(mounted)
      expect(providerSpawn).toHaveBeenCalledTimes(2)
      expect(providerSpawn.mock.calls[1]?.[0]).toMatchObject({
        attachOnly: true,
        sessionId: 'pty-live-owner'
      })
      expect(providerSpawn.mock.calls[1]?.[0].command).toBeUndefined()
      expect(runtime.createPreAllocatedTerminalHandle).not.toHaveBeenCalled()
      expect(prepareClaudeAuth).not.toHaveBeenCalled()
      expect(runtime.registerPreAllocatedHandleForPty).not.toHaveBeenCalled()
      expect(runtime.noteTerminalSpawnCommand).not.toHaveBeenCalled()
      expect(trackMock).not.toHaveBeenCalledWith('agent_started', expect.anything())
      expect(runtime.onPtyExit).not.toHaveBeenCalled()
      expect(getPtyIdForPaneKey(paneKey)).toBe('pty-live-owner')

      resetAttachBarrier()
      store.persistPtyBinding.mockClear()
      mainWindow.webContents.send.mockClear()
      const adoptionArgs = { cols: 120, rows: 40, cwd, worktreeId, tabId, leafId }
      let runtimeSecondAdoption: Promise<StableAdoption> | null = null
      runtime.beginPtyRegistration.mockImplementation(() => {
        runtimeSecondAdoption ??= spawnController.adoptStablePane(adoptionArgs)
      })
      const rendererFirstMount = handlers.get('pty:spawn')!(null, mountArgs)
      await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledTimes(3))
      releaseAttach()
      await vi.waitFor(() => expect(runtimeSecondAdoption).not.toBeNull())
      const pendingRuntimeAdoption = runtimeSecondAdoption
      if (!pendingRuntimeAdoption) {
        throw new Error('runtime adoption did not enter during renderer publication')
      }
      const adoptedOwner = await pendingRuntimeAdoption
      expect(adoptedOwner).toMatchObject({ materialized: true })

      const claimedResultPromise = spawnController.spawn({
        cols: 120,
        rows: 40,
        cwd,
        command: 'codex resume should-not-run',
        worktreeId,
        preAllocatedHandle: 'term-live-owner',
        tabId,
        leafId,
        env: { ORCA_PANE_KEY: paneKey },
        persistHostSessionBinding: true,
        adoptedStablePane: adoptedOwner,
        agentSessionEnsure: {
          claim: {
            ...recoveredAgentClaim,
            identityDigest: 'ccccccccccccccccccccccccccccccccccccccccccc'
          },
          surface: { worktreeId, tabId, leafId, terminalHandle: 'term-live-owner' }
        },
        agentSessionCreateOperationId: 'create-op-must-not-run'
      })
      const [rendererFirstResult, claimedResult] = await Promise.all([
        rendererFirstMount,
        claimedResultPromise
      ])
      expect(rendererFirstResult).toMatchObject({
        id: 'pty-live-owner',
        incarnationId: 'inc-live-owner',
        isReattach: true
      })
      expect(claimedResult).toMatchObject({
        id: 'pty-live-owner',
        stablePaneOwner: { handle: 'term-live-owner', tabId, leafId }
      })
      expect(providerSpawn).toHaveBeenCalledTimes(3)
      expect(supportsAgentSessionClaims).not.toHaveBeenCalled()
      expect(supportsAgentSessionCreateOperations).not.toHaveBeenCalled()
      expect(store.persistPtyBinding).toHaveBeenCalledOnce()
      expect(
        mainWindow.webContents.send.mock.calls.filter(([channel]) => channel === 'pty:spawned')
      ).toHaveLength(1)
    }
  )

  it('adopts an exact persisted owner when the runtime projection is missing', async () => {
    const tabId = 'tab-persisted-owner'
    const leafId = '88888888-8888-4888-8888-888888888888'
    const paneKey = makePaneKey(tabId, leafId)
    const worktreeId = 'repo-1::/tmp/persisted-owner'
    const providerSpawn = vi.fn(async (options: { attachOnly?: boolean; sessionId?: string }) => ({
      id: options.sessionId ?? 'unexpected-fresh-id',
      incarnationId: 'inc-persisted-owner',
      isReattach: options.attachOnly === true,
      snapshot: 'persisted-owner-output'
    }))
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
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-rebuilt-owner'),
      registerPreAllocatedHandleForPty: vi.fn(),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      assertPtyRegistrationAllowed: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      onPtyExit: vi.fn()
    }
    const store = {
      getWorkspaceSession: vi.fn(() => ({
        tabsByWorktree: {
          [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-persisted-owner' }]
        },
        terminalLayoutsByTabId: {
          [tabId]: { ptyIdsByLeafId: { [leafId]: 'pty-persisted-owner' } }
        },
        terminalPtyIncarnationsByPaneKey: {
          [paneKey]: 'inc-persisted-owner'
        }
      })),
      persistPtyBinding: vi.fn()
    }

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const mounted = await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp/persisted-owner',
      command: 'codex resume provider-session',
      worktreeId,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: worktreeId
      }
    })

    expect(mounted).toMatchObject({
      id: 'pty-persisted-owner',
      incarnationId: 'inc-persisted-owner',
      isReattach: true
    })
    expect(providerSpawn).toHaveBeenCalledOnce()
    expect(providerSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        attachOnly: true,
        sessionId: 'pty-persisted-owner',
        command: undefined
      })
    )
    expect(runtime.registerPreAllocatedHandleForPty).toHaveBeenCalledWith(
      'pty-persisted-owner',
      'term-rebuilt-owner'
    )
    expect(runtime.noteTerminalSpawnCommand).not.toHaveBeenCalled()
    expect(store.persistPtyBinding).toHaveBeenCalledOnce()
    expect(
      mainWindow.webContents.send.mock.calls.filter(([channel]) => channel === 'pty:spawned')
    ).toHaveLength(1)
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'git worktree',
      worktreeId: 'repo-1::/tmp/dead-persisted-owner',
      cwd: '/tmp/dead-persisted-owner',
      folderMissing: false
    },
    {
      label: 'missing folder workspace',
      worktreeId: 'folder:dead-persisted-owner',
      cwd: '/tmp/missing-dead-persisted-owner',
      folderMissing: true
    }
  ])(
    'retires a persistence-only dead owner before fresh recovery ($label)',
    async ({ worktreeId, cwd, folderMissing }) => {
      const tabId = 'tab-dead-persisted-owner'
      const leafId = '12121212-1212-4212-8212-121212121212'
      const paneKey = makePaneKey(tabId, leafId)
      const providerSpawn = vi.fn(
        async (options: { attachOnly?: boolean; command?: string; sessionId?: string }) => {
          if (options.attachOnly) {
            throw new Error('Session not found: pty-dead-persisted-owner')
          }
          return { id: 'pty-fresh-recovery', incarnationId: 'inc-fresh-recovery' }
        }
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
      let session = {
        tabsByWorktree: {
          [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-dead-persisted-owner' }]
        },
        terminalLayoutsByTabId: {
          [tabId]: {
            root: { type: 'leaf' as const, leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: 'pty-dead-persisted-owner' }
          }
        },
        terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-dead-persisted-owner' }
      }
      const store = {
        getWorkspaceSession: vi.fn(() => session),
        setWorkspaceSession: vi.fn((next) => {
          session = next
        }),
        flushOrThrow: vi.fn(),
        persistPtyBinding: vi.fn(),
        getFolderWorkspace: vi.fn(() => ({
          id: 'dead-persisted-owner',
          folderPath: cwd,
          projectGroupId: 'folder-group'
        })),
        getFolderWorkspaces: vi.fn(() => [
          {
            id: 'dead-persisted-owner',
            folderPath: cwd,
            projectGroupId: 'folder-group'
          }
        ]),
        getProjectGroups: vi.fn(() => []),
        getRepos: vi.fn(() => [])
      }
      const runtime = {
        setPtyController: vi.fn(),
        resolveTerminalPane: vi.fn(() => {
          throw new Error('terminal_not_found')
        }),
        createPreAllocatedTerminalHandle: vi.fn(() => 'term-fresh-recovery'),
        preAllocateHandleForPty: vi.fn(() => 'term-fresh-recovery'),
        registerPreAllocatedHandleForPty: vi.fn(),
        beginPtyRegistration: vi.fn(),
        cancelPendingPtyRegistration: vi.fn(),
        assertPtyRegistrationAllowed: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        seedHeadlessTerminal: vi.fn(),
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
      if (folderMissing) {
        statSyncMock.mockImplementation(() => {
          throw Object.assign(new Error('missing folder'), { code: 'ENOENT' })
        })
      }
      const mountedPromise = handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd,
        command: 'codex resume exact-dead-provider-session',
        worktreeId,
        tabId,
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: worktreeId
        }
      })

      if (folderMissing) {
        await expect(mountedPromise).rejects.toThrow(`folder_workspace_path_missing:${cwd}`)
        expect(providerSpawn).toHaveBeenCalledOnce()
        expect(providerSpawn.mock.calls[0]?.[0]).toMatchObject({
          attachOnly: true,
          sessionId: 'pty-dead-persisted-owner',
          command: undefined
        })
        expect(store.setWorkspaceSession).toHaveBeenCalledOnce()
        expect(runtime.onPtyExit).toHaveBeenCalledWith(
          'pty-dead-persisted-owner',
          0,
          'inc-dead-persisted-owner'
        )
        return
      }
      const mounted = await mountedPromise

      expect(mounted).toMatchObject({
        id: 'pty-fresh-recovery',
        incarnationId: 'inc-fresh-recovery'
      })
      expect(providerSpawn).toHaveBeenCalledTimes(2)
      expect(providerSpawn.mock.calls[0]?.[0]).toMatchObject({
        attachOnly: true,
        sessionId: 'pty-dead-persisted-owner',
        command: undefined
      })
      expect(providerSpawn.mock.calls[1]?.[0]).toMatchObject({
        command: 'codex resume exact-dead-provider-session'
      })
      expect(store.setWorkspaceSession).toHaveBeenCalledOnce()
      expect(store.flushOrThrow).toHaveBeenCalledOnce()
      expect(runtime.onPtyExit).toHaveBeenCalledWith(
        'pty-dead-persisted-owner',
        0,
        'inc-dead-persisted-owner'
      )
    }
  )

  it.each([
    { label: 'another owner reports it alive', liveness: true },
    { label: 'no owner could answer', liveness: null }
  ])('keeps a persisted owner whose absence is unproven ($label)', async ({ liveness }) => {
    const worktreeId = 'repo-1::/tmp/unproven-owner'
    const cwd = '/tmp/unproven-owner'
    const tabId = 'tab-unproven-owner'
    const leafId = '56565656-5656-4656-8656-565656565656'
    const paneKey = makePaneKey(tabId, leafId)
    // Why: a degraded router answers unmapped ids from the local fallback, which never
    // owned this daemon session — the same "Session not found" a truly dead PTY yields.
    const providerSpawn = vi.fn(
      async (options: { attachOnly?: boolean; command?: string; sessionId?: string }) => {
        if (options.attachOnly) {
          throw new Error('Session not found: pty-unproven-owner')
        }
        return { id: 'pty-fresh-unproven', incarnationId: 'inc-fresh-unproven' }
      }
    )
    const probePtyLiveness = vi.fn(async () => liveness)
    setLocalPtyProvider({
      spawn: providerSpawn,
      probePtyLiveness,
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
    let session = {
      tabsByWorktree: {
        [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-unproven-owner' }]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-unproven-owner' }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-unproven-owner' }
    }
    const store = {
      getWorkspaceSession: vi.fn(() => session),
      setWorkspaceSession: vi.fn((next) => {
        session = next
      }),
      flushOrThrow: vi.fn(),
      persistPtyBinding: vi.fn(),
      getFolderWorkspace: vi.fn(() => undefined),
      getFolderWorkspaces: vi.fn(() => []),
      getProjectGroups: vi.fn(() => []),
      getRepos: vi.fn(() => [])
    }
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-unproven'),
      preAllocateHandleForPty: vi.fn(() => 'term-unproven'),
      registerPreAllocatedHandleForPty: vi.fn(),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      assertPtyRegistrationAllowed: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
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

    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd,
        command: 'codex resume unproven-owner-session',
        worktreeId,
        tabId,
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: worktreeId
        }
      })
    ).rejects.toThrow('terminal_pane_owner_unverified')

    expect(probePtyLiveness).toHaveBeenCalledWith('pty-unproven-owner')
    // The live PTY keeps its pane binding, gets no synthetic exit, and is not duplicated.
    expect(providerSpawn).toHaveBeenCalledOnce()
    expect(providerSpawn.mock.calls[0]?.[0]).toMatchObject({ attachOnly: true })
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(store.flushOrThrow).not.toHaveBeenCalled()
    expect(session.tabsByWorktree[worktreeId]).toHaveLength(1)
  })

  // Why the positive direction needs its own case: the sibling retire tests use providers with
  // no `probePtyLiveness`, so they skip this guard entirely. Without this, the guard could be
  // strengthened into a permanent veto — no daemon-backed pane could ever recover from a dead
  // owner — and every suite would stay green.
  it('still retires and respawns when a provider proves the owner is absent', async () => {
    const worktreeId = 'repo-1::/tmp/proven-absent-owner'
    const cwd = '/tmp/proven-absent-owner'
    const tabId = 'tab-proven-absent-owner'
    const leafId = '78787878-7878-4878-8878-787878787878'
    const paneKey = makePaneKey(tabId, leafId)
    const providerSpawn = vi.fn(
      async (options: { attachOnly?: boolean; command?: string; sessionId?: string }) => {
        if (options.attachOnly) {
          throw new Error('Session not found: pty-proven-absent-owner')
        }
        return { id: 'pty-fresh-proven', incarnationId: 'inc-fresh-proven' }
      }
    )
    const probePtyLiveness = vi.fn(async () => false)
    setLocalPtyProvider({
      spawn: providerSpawn,
      probePtyLiveness,
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
    let session = {
      tabsByWorktree: {
        [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-proven-absent-owner' }]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-proven-absent-owner' }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-proven-absent-owner' }
    }
    const store = {
      getWorkspaceSession: vi.fn(() => session),
      setWorkspaceSession: vi.fn((next) => {
        session = next
      }),
      flushOrThrow: vi.fn(),
      persistPtyBinding: vi.fn(),
      getFolderWorkspace: vi.fn(() => undefined),
      getFolderWorkspaces: vi.fn(() => []),
      getProjectGroups: vi.fn(() => []),
      getRepos: vi.fn(() => [])
    }
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-proven-absent'),
      preAllocateHandleForPty: vi.fn(() => 'term-proven-absent'),
      registerPreAllocatedHandleForPty: vi.fn(),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      assertPtyRegistrationAllowed: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
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

    const mounted = await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd,
      command: 'codex resume proven-absent-session',
      worktreeId,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: worktreeId
      }
    })

    expect(probePtyLiveness).toHaveBeenCalledWith('pty-proven-absent-owner')
    // Proven absence is the one answer that authorizes retirement, so recovery must proceed.
    expect(mounted).toMatchObject({ id: 'pty-fresh-proven' })
    expect(providerSpawn).toHaveBeenCalledTimes(2)
    expect(providerSpawn.mock.calls[1]?.[0]).toMatchObject({
      command: 'codex resume proven-absent-session'
    })
    expect(runtime.onPtyExit).toHaveBeenCalledWith(
      'pty-proven-absent-owner',
      0,
      'inc-proven-absent-owner'
    )
    expect(store.setWorkspaceSession).toHaveBeenCalledOnce()
    expect(store.flushOrThrow).toHaveBeenCalledOnce()
  })

  // Why: a parked pane (stopped with keepHistory) leaves the runtime holding the binding while
  // persistence has already dropped it. Reading "nothing left to retire" as a competing owner
  // aborted materialization *after* signalling the exit, which destroyed the pane instead of
  // rebuilding it — the reconnect path then had no surface to attach to (#11541).
  it('respawns a proven-dead owner whose persisted binding was already retired', async () => {
    const worktreeId = 'repo-1::/tmp/already-retired-owner'
    const cwd = '/tmp/already-retired-owner'
    const tabId = 'tab-already-retired-owner'
    const leafId = '89898989-8989-4989-8989-898989898989'
    const paneKey = makePaneKey(tabId, leafId)
    const providerSpawn = vi.fn(
      async (options: { attachOnly?: boolean; command?: string; sessionId?: string }) => {
        if (options.attachOnly) {
          throw new Error('Session not found: pty-already-retired-owner')
        }
        return { id: 'pty-fresh-already-retired', incarnationId: 'inc-fresh-already-retired' }
      }
    )
    const probePtyLiveness = vi.fn(async () => false)
    setLocalPtyProvider({
      spawn: providerSpawn,
      probePtyLiveness,
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
    // Persistence kept the tab but already dropped this leaf's PTY binding, exactly as an
    // earlier keep-history stop leaves it.
    let session = {
      tabsByWorktree: {
        [worktreeId]: [{ id: tabId, worktreeId, ptyId: null }]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      },
      terminalPtyIncarnationsByPaneKey: {}
    }
    const store = {
      getWorkspaceSession: vi.fn(() => session),
      setWorkspaceSession: vi.fn((next) => {
        session = next
      }),
      flushOrThrow: vi.fn(),
      persistPtyBinding: vi.fn(),
      getFolderWorkspace: vi.fn(() => undefined),
      getFolderWorkspaces: vi.fn(() => []),
      getProjectGroups: vi.fn(() => []),
      getRepos: vi.fn(() => [])
    }
    let runtimeOwnsPane = true
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => {
        if (!runtimeOwnsPane) {
          throw new Error('terminal_not_found')
        }
        return {
          ptyId: 'pty-already-retired-owner',
          tabId,
          leafId,
          handle: 'term-already-retired',
          connected: true
        }
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-already-retired-fresh'),
      preAllocateHandleForPty: vi.fn(() => 'term-already-retired-fresh'),
      registerPreAllocatedHandleForPty: vi.fn(),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      assertPtyRegistrationAllowed: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      onPtySpawned: vi.fn(),
      // Why: the real runtime drops its pane binding on exit; the guard after retirement must
      // see that release rather than a resurrected owner.
      onPtyExit: vi.fn(() => {
        runtimeOwnsPane = false
      }),
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

    const mounted = await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd,
      command: 'codex resume already-retired-session',
      worktreeId,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: worktreeId
      }
    })

    expect(probePtyLiveness).toHaveBeenCalledWith('pty-already-retired-owner')
    expect(mounted).toMatchObject({ id: 'pty-fresh-already-retired' })
    expect(providerSpawn).toHaveBeenCalledTimes(2)
    expect(providerSpawn.mock.calls[1]?.[0]).toMatchObject({
      command: 'codex resume already-retired-session'
    })
    expect(runtime.onPtyExit).toHaveBeenCalledWith('pty-already-retired-owner', 0, undefined)
  })

  it('retires a dead owner from the exact SSH host session before fresh recovery', async () => {
    const connectionId = 'ssh-dead-stable-pane'
    const hostId = `ssh:${connectionId}`
    const tabId = 'tab-dead-ssh-owner'
    const leafId = '34343434-3434-4434-8434-343434343434'
    const paneKey = makePaneKey(tabId, leafId)
    const worktreeId = 'repo-ssh::/remote/dead-stable-pane'
    const deadPtyId = `ssh:${connectionId}@@dead-relay-pty`
    const freshPtyId = `ssh:${connectionId}@@fresh-relay-pty`
    const remoteSpawn = vi.fn(async (options: { attachOnly?: boolean; command?: string }) => {
      if (options.attachOnly) {
        throw new Error('PTY "dead-relay-pty" not found')
      }
      return { id: freshPtyId, incarnationId: 'inc-fresh-ssh-owner' }
    })
    registerSshPtyProvider(connectionId, {
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
    let session = {
      tabsByWorktree: {
        [worktreeId]: [{ id: tabId, worktreeId, ptyId: deadPtyId }]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: deadPtyId }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-dead-ssh-owner' }
    }
    const store = {
      getWorkspaceSession: vi.fn((requestedHostId?: string) => {
        expect(requestedHostId).toBe(hostId)
        return session
      }),
      setWorkspaceSession: vi.fn((next, requestedHostId?: string) => {
        expect(requestedHostId).toBe(hostId)
        session = next
      }),
      flushOrThrow: vi.fn(),
      persistPtyBinding: vi.fn(),
      upsertSshRemotePtyLease: vi.fn(),
      removeSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    }
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-fresh-ssh-owner'),
      registerPreAllocatedHandleForPty: vi.fn(),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      assertPtyRegistrationAllowed: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
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
      const mounted = await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/remote/dead-stable-pane',
        command: 'codex resume exact-dead-ssh-provider-session',
        connectionId,
        worktreeId,
        tabId,
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: worktreeId
        }
      })

      expect(mounted).toMatchObject({ id: freshPtyId, incarnationId: 'inc-fresh-ssh-owner' })
      expect(remoteSpawn).toHaveBeenCalledTimes(2)
      expect(remoteSpawn.mock.calls[0]?.[0]).toMatchObject({
        attachOnly: true,
        sessionId: deadPtyId,
        command: undefined
      })
      expect(remoteSpawn.mock.calls[1]?.[0]).toMatchObject({
        command: 'codex resume exact-dead-ssh-provider-session'
      })
      expect(store.setWorkspaceSession).toHaveBeenCalledWith(expect.anything(), hostId)
      expect(store.persistPtyBinding).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId,
          tabId,
          leafId,
          ptyId: freshPtyId
        }),
        hostId
      )
    } finally {
      unregisterSshPtyProvider(connectionId)
    }
  })

  it('fails closed when runtime and persisted stable-pane owners conflict', async () => {
    const tabId = 'tab-conflicting-owner'
    const leafId = '99999999-9999-4999-8999-999999999999'
    const paneKey = makePaneKey(tabId, leafId)
    const worktreeId = 'repo-1::/tmp/conflicting-owner'
    const providerSpawn = vi.fn()
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
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => ({
        handle: 'term-runtime-owner',
        tabId,
        leafId,
        ptyId: 'pty-runtime-owner',
        worktreeId
      })),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-provisional')
    }
    const store = {
      getWorkspaceSession: vi.fn(() => ({
        tabsByWorktree: {
          [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-persisted-owner' }]
        },
        terminalLayoutsByTabId: {
          [tabId]: { ptyIdsByLeafId: { [leafId]: 'pty-persisted-owner' } }
        }
      }))
    }

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )

    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp/conflicting-owner',
        worktreeId,
        tabId,
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: worktreeId
        }
      })
    ).rejects.toThrow('terminal_pane_owner_conflict')
    expect(providerSpawn).not.toHaveBeenCalled()
  })

  it('does not coalesce identical pane coordinates across worktrees', async () => {
    const providerSpawn = vi.fn(async () => ({ id: `pty-${providerSpawn.mock.calls.length}` }))
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
    registerPtyHandlers(mainWindow as never)
    const leafId = '77777777-7777-4777-8777-777777777777'
    const paneKey = makePaneKey('tab-host-scope', leafId)
    const spawn = (worktreeId: string) =>
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        worktreeId,
        tabId: 'tab-host-scope',
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-host-scope',
          ORCA_WORKTREE_ID: worktreeId
        }
      })

    await Promise.all([spawn('repo-1::/tmp/a'), spawn('repo-1::/tmp/b')])

    expect(providerSpawn).toHaveBeenCalledTimes(2)
  })

  it('settles the pane reservation when a post-spawn step throws so later spawns do not hang', async () => {
    // Why: reservation-leak regression — a post-spawn throw after provider.spawn resolves must reject/clear the reservation, else later spawns for the same pane key hang forever.
    registerPtyHandlers(mainWindow as never)
    const leafId = '44444444-4444-4444-8444-444444444444'
    const spawnArgs = { cols: 80, rows: 24, tabId: 'tab-reservation', leafId }

    registerPtyMock.mockImplementationOnce(() => {
      throw new Error('boom: post-spawn registration failed')
    })

    await expect(handlers.get('pty:spawn')!(null, spawnArgs)).rejects.toThrow('boom')

    // A second spawn for the same pane must run a fresh spawn rather than await the leaked (never-settled) reservation promise.
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
    // Why: like the renderer-path regression, the runtime spawn path must clear its own reservation when a post-spawn step throws, else the next materialization hangs forever.
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

    // The reservation must be gone, so a second materialization runs a fresh provider.spawn instead of awaiting the leaked promise.
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
      markSshRemotePtyLease: vi.fn(),
      retireLeaseAndReap: vi.fn(),
      clearSshRemotePtyLeaseReapFlag: vi.fn()
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
    expect(store.persistPtyBinding).toHaveBeenCalledWith(
      {
        worktreeId: 'wt-remote',
        tabId: 'tab-remote',
        leafId,
        ptyId: 'ssh:ssh-1@@relay-pty'
      },
      'ssh:ssh-1'
    )
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
      markSshRemotePtyLease: vi.fn(),
      retireLeaseAndReap: vi.fn(),
      clearSshRemotePtyLeaseReapFlag: vi.fn()
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

      expect(store.persistPtyBinding).toHaveBeenCalledWith(
        {
          worktreeId: 'wt-remote',
          tabId: 'tab-remote',
          leafId,
          ptyId: 'ssh:ssh-reattach-ok@@relay-pty'
        },
        'ssh:ssh-reattach-ok'
      )
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
    const remoteSpawn = vi.fn(
      async (_opts: { env?: Record<string, string>; envToDelete?: string[] }) => ({
        id: 'ssh:ssh-runtime-env@@relay-pty'
      })
    )
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
        (() => ({
          agentStatusHooksEnabled: false,
          codexSystemDefaultRealHomeEnabled: true
        })) as never,
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

      const spawnOptions = remoteSpawn.mock.calls[0]?.[0]
      const env = spawnOptions.env
      expect(env).toMatchObject({ FOO: 'bar' })
      expect(env?.ORCA_PANE_KEY).toBeUndefined()
      expect(env?.ORCA_TAB_ID).toBeUndefined()
      expect(env?.ORCA_WORKTREE_ID).toBeUndefined()
      expect(spawnOptions.envToDelete ?? []).not.toContain('CODEX_HOME')
      expect(spawnOptions.envToDelete ?? []).not.toContain('ORCA_CODEX_HOME')
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

  it('preserves adopted SSH ownership when runtime binding persistence fails', async () => {
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
      markSshRemotePtyLease: vi.fn(),
      retireLeaseAndReap: vi.fn(),
      clearSshRemotePtyLeaseReapFlag: vi.fn()
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
      data: 'echo remains-routable'
    })
    expect(remoteWrite).toHaveBeenCalledWith(
      'ssh:ssh-reattach-fail@@relay-pty',
      'echo remains-routable'
    )
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
      markSshRemotePtyLease: vi.fn(),
      retireLeaseAndReap: vi.fn(),
      clearSshRemotePtyLeaseReapFlag: vi.fn()
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
      markSshRemotePtyLease: vi.fn(),
      retireLeaseAndReap: vi.fn(),
      clearSshRemotePtyLeaseReapFlag: vi.fn()
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
    const incarnationId = 'incarnation-fresh-fail'
    const runtime = new OrcaRuntimeService()
    const remoteShutdown = vi.fn(async () => {
      // Model the relay's exit callback winning before shutdown resolves.
      runtime.onPtyExit(appPtyId, 0, incarnationId)
    })
    registerSshPtyProvider('ssh-fresh-fail', {
      spawn: vi.fn(async () => ({ id: appPtyId, incarnationId })),
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
      markSshRemotePtyLease: vi.fn(),
      retireLeaseAndReap: vi.fn(),
      clearSshRemotePtyLeaseReapFlag: vi.fn()
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
      const spawnController = (runtime as unknown as { ptyController: RuntimeSpawnController })
        .ptyController
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
      const internals = runtime as unknown as {
        earlyExitedPtyIncarnations: Map<string, string | null>
        pendingPtyRegistrationIncarnations: Map<string, string | null>
      }
      expect(internals.earlyExitedPtyIncarnations.size).toBe(0)
      expect(internals.pendingPtyRegistrationIncarnations.size).toBe(0)
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
      getRendererSerializerGeneration?(ptyId: string): number
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
    const replacementGen = (await handlers.get('pty:declarePendingPaneSerializer')!(null, {
      paneKey
    })) as number

    expect(spawnController.hasRendererSerializer?.(result.id)).toBe(false)
    await handlers.get('pty:settlePaneSerializer')!(null, { paneKey, gen })
    expect(spawnController.hasRendererSerializer?.(result.id)).toBe(false)
    expect(spawnController.getRendererSerializerGeneration?.(result.id)).toBe(0)
    await handlers.get('pty:settlePaneSerializer')!(null, { paneKey, gen: replacementGen })
    expect(spawnController.hasRendererSerializer?.(result.id)).toBe(true)
    expect(spawnController.getRendererSerializerGeneration?.(result.id)).toBe(1)
  })

  it('does not let old teardown cancel serializer settlement for a reused PTY id', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        env?: Record<string, string>
      }): Promise<{ id: string }>
      getRendererSerializerGeneration?(ptyId: string): number
      hasRendererSerializer?(ptyId: string): boolean
      waitForRendererSerializer?(
        ptyId: string,
        afterGeneration: number,
        timeoutMs?: number
      ): Promise<boolean>
    }
    const reusedPtyId = 'pty-reused'
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: reusedPtyId })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      preAllocateHandleForPty: vi.fn(() => null),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    const paneKey = makePaneKey('tab-reused', '33333333-3333-4333-8333-333333333333')
    const spawnController = controller as unknown as RuntimeSpawnController
    const spawn = async (): Promise<void> => {
      await spawnController.spawn({
        cols: 80,
        rows: 24,
        worktreeId: 'wt-1',
        env: { ORCA_PANE_KEY: paneKey }
      })
    }

    const firstGen = (await handlers.get('pty:declarePendingPaneSerializer')!(null, {
      paneKey
    })) as number
    await spawn()
    await handlers.get('pty:settlePaneSerializer')!(null, { paneKey, gen: firstGen })
    const priorGeneration = spawnController.getRendererSerializerGeneration?.(reusedPtyId) ?? 0

    const secondGen = (await handlers.get('pty:declarePendingPaneSerializer')!(null, {
      paneKey
    })) as number
    await spawn()
    const ready = spawnController.waitForRendererSerializer?.(reusedPtyId, priorGeneration, 1_000)
    clearProviderPtyState(reusedPtyId)
    clearProviderPtyState(reusedPtyId)
    await handlers.get('pty:settlePaneSerializer')!(null, { paneKey, gen: secondGen })

    await expect(ready).resolves.toBe(true)
    expect(spawnController.hasRendererSerializer?.(reusedPtyId)).toBe(true)
  })

  it('tracks exact remote-runtime serializer readiness without a local spawn mapping', async () => {
    type RuntimeSpawnController = {
      hasRendererSerializer?(ptyId: string): boolean
      getRendererSerializerGeneration?(ptyId: string): number
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      })
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    const ptyId = 'remote:env-1@@terminal-1'
    const spawnController = controller as unknown as RuntimeSpawnController

    expect(spawnController.hasRendererSerializer?.(ptyId)).toBe(false)
    await handlers.get('pty:reportRendererSerializerReady')!(null, { ptyId: 'local-pty' })
    expect(spawnController.hasRendererSerializer?.('local-pty')).toBe(false)
    await handlers.get('pty:reportRendererSerializerReady')!(null, { ptyId })
    expect(spawnController.hasRendererSerializer?.(ptyId)).toBe(true)
    expect(spawnController.getRendererSerializerGeneration?.(ptyId)).toBe(1)
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
        // Why: bare WSL shells no longer create ~/.omp; only status extension is exported (#10196).
        'ORCA_OMP_STATUS_EXTENSION/p',
        'POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD'
      ])
    )
    expect(env.WSLENV?.split(':')).not.toEqual(
      expect.arrayContaining(['ORCA_OMP_SOURCE_AGENT_DIR/p'])
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
      // Why: the spawn path resolves a bare PowerShell name to an absolute exe (PR #6537 / issue #5161); pin the probed install roots for deterministic resolution across host OS.
      for (const key of ['SystemRoot', 'ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
        savedWindowsResolutionEnv[key] = process.env[key]
      }
      process.env.SystemRoot = 'C:\\Windows'
      process.env.ProgramW6432 = 'C:\\Program Files'
      process.env.ProgramFiles = 'C:\\Program Files'
      delete process.env['ProgramFiles(x86)']
      // Why: .exe candidates must report isFile()/size (default mock omits them, collapsing every PowerShell candidate to cmd.exe); dirs must still report isDirectory().
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
        ['-c', 'chcp.com 65001 >/dev/null 2>&1; exec "$BASH" --login -i'],
        expect.objectContaining({
          env: expect.objectContaining({ CHERE_INVOKING: '1' })
        })
      )
    })

    it('uses terminalWindowsShell setting over COMSPEC when provided', async () => {
      // Why: COMSPEC always points to cmd.exe on stock Windows, so without the setting the terminal would ignore the user's shell preference.
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
    // Why: the floating sentinel has no worktree root; its cwd is validated against trusted-directory grants before reaching pty:spawn.
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

  it('rejects a renderer spawn while destructive worktree removal holds the gate', async () => {
    const removal = acquireWatcherRemovalGate('/repo/app')
    await removal.ready
    registerPtyHandlers(mainWindow as never)

    try {
      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          worktreeId: 'repo-1::/repo/app'
        })
      ).rejects.toMatchObject({ code: 'terminal_removal_in_progress' })
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      removal.release()
    }
  })

  it('rejects a sibling-worktree terminal cwd inside a worktree being removed', async () => {
    const removal = acquireWatcherRemovalGate('/repo/app')
    await removal.ready
    registerPtyHandlers(mainWindow as never)

    try {
      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/repo/app/nested',
          worktreeId: 'repo-1::/repo/sibling'
        })
      ).rejects.toMatchObject({ code: 'terminal_removal_in_progress' })
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      removal.release()
    }
    const siblingRemoval = acquireWatcherRemovalGate('/repo/sibling')
    await siblingRemoval.ready
    siblingRemoval.release()
  })

  it('rejects a runtime sibling-worktree cwd inside a removing worktree', async () => {
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      spawn(args: {
        cols: number
        rows: number
        cwd?: string
        worktreeId?: string
        env?: Record<string, string>
      }): Promise<{ id: string }>
    }
    const removal = acquireWatcherRemovalGate('/repo/app')
    await removal.ready

    try {
      await expect(
        controller.spawn({
          cols: 80,
          rows: 24,
          cwd: '/repo/app/nested',
          worktreeId: 'repo-1::/repo/sibling',
          env: {}
        })
      ).rejects.toMatchObject({ code: 'terminal_removal_in_progress' })
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      removal.release()
    }
  })

  it('falls back to the worktree root when a saved local cwd no longer exists', async () => {
    registerPtyHandlers(mainWindow as never)
    // Why: issue #7239 reproduced in a Japanese-named worktree; the fallback must return the selected worktree path verbatim.
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

    // Why: without the renderer opt-in the provider surfaces its normal missing-directory error — API/runtime callers keep exact cwd semantics.
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

    // Why: a reattach must keep the session's exact cwd; remapping would silently detach the restored terminal from its recorded state.
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

    // Why: the startup-cwd guard normalizes separators, so the provider sees the forward-slash UNC form.
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

  posixOnlyIt('wraps macOS spawns in login(1) with SHELL restored by the trampoline', async () => {
    const originalShell = process.env.SHELL
    // Re-enable the TCC login wrapper the suite-level beforeEach disables.
    delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    process.env.SHELL = '/bin/zsh'
    loginPreflightExecFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(null, 'ORCA_LOGIN_PREFLIGHT_OK', '')
        return { stdin: { end: vi.fn() } }
      }
    )
    resetMacosLoginShellPreflightForTests()

    try {
      const [file, args, options] = await spawnAndGetCall({ cwd: '/tmp' })
      expect(file).toBe('/usr/bin/login')
      expect(args).toEqual([
        '-flpq',
        userInfo().username,
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-p',
        '-c',
        'export SHELL="$1"; shift; exec -l -- "$@"',
        'orca-tcc-login',
        '/bin/zsh',
        '/bin/zsh',
        '-l'
      ])
      // The spawn env keeps the real shell so identity/name logic is intact.
      expect(options.env.SHELL).toBe('/bin/zsh')
    } finally {
      resetMacosLoginShellPreflightForTests()
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
      const handleRendererLoading = getMainFrameNavigationListener()
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
      const handleRendererLoading = getMainFrameNavigationListener()
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      // Drain the initial dispatcher-ready flush (beforeEach fires the handshake to model a live page) so flood timing starts clean.
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

      // Renderer reload: the dead page never ACKs, so its in-flight/pending accounting must clear or the surviving PTY stays gated forever.
      handleRendererLoading()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        rendererInFlightPtyCount: 0,
        pendingChars: 0,
        pendingPtyCount: 0,
        rendererLifecycleResetCount: 1,
        lastLifecycleResetClearedChars: 512 * 1024
      })

      // Boot window (§1b): dispatcher not re-registered, so sends must be held — bytes into the listener-less page drop yet count in-flight, re-pinning the gate.
      mainWindow.webContents.send.mockClear()
      mockProc.emitData('post-reload output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: 'post-reload output'.length,
        pendingPtyCount: 1
      })

      // The dispatcher-ready handshake releases the held backlog; assert delivery actually resumes and pending drains, not just counters-zero.
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

  it('ignores overlapping subframe navigation so an in-page iframe cannot reclose delivery', async () => {
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
      const handleRendererNavigation = getMainWindowWebContentsListener('did-start-navigation')
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
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

      // Main navigation closes the gate; the fresh dispatcher reopens it before an overlapping iframe navigates.
      handleRendererNavigation({ isMainFrame: true, isSameDocument: false })
      handleRendererDispatcherReady()
      handleRendererNavigation({ isMainFrame: false, isSameDocument: false })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: 0,
        pendingPtyCount: 0,
        rendererLifecycleResetCount: 1,
        lastLifecycleResetClearedChars: 512 * 1024,
        rendererPtyDispatcherReady: true
      })

      // Gate remains open: output after the iframe navigation reaches the fresh page without waiting for the watchdog.
      mainWindow.webContents.send.mockClear()
      mockProc.emitData('post-subframe output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-subframe output'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: true,
        rendererDispatcherReadyForcedCount: 0
      })
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

      // Handshake while the gate is open proves a missed lifecycle reset; reconcile or survivors stay pinned at the cap.
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

      // Delivery has resumed: fresh output flows immediately instead of piling up behind the stale cap.
      mockProc.emitData('post-reconcile output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-reconcile output'
      })

      // A straggler ACK from the dead page is clamped and cannot underflow the reconciled counters below zero.
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
      const handleRendererLoading = getMainFrameNavigationListener()
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      const writeListener = getPtyWriteListener()
      // Drain the initial ready-flush the beforeEach handshake schedules.
      vi.advanceTimersByTime(1)

      // Reload closes the gate; the reloaded page's dispatcher has not re-registered.
      handleRendererLoading()
      mainWindow.webContents.send.mockClear()

      // With shouldSendInteractiveOutputNow() true, only the `&& rendererPtyDispatcherReady` guard keeps the interactive echo out of the still-listener-less page.
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
      const handleRendererLoading = getMainFrameNavigationListener()
      vi.advanceTimersByTime(1)

      // Reload closes the gate and arms the ~10s watchdog; the reloaded page never sends the handshake (dropped IPC), so output stays held.
      handleRendererLoading()
      mainWindow.webContents.send.mockClear()
      mockProc.emitData('post-reload output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: false,
        rendererDispatcherReadyForcedCount: 0
      })

      // Past the 10s watchdog window the gate self-heals (ready forced, backlog drains) instead of freezing permanently.
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
      const handleRendererLoading = getMainFrameNavigationListener()
      const readyCall = onMock.mock.calls.find(
        (call: unknown[]) => call[0] === 'pty:rendererDispatcherReady'
      )!
      const rawReadyListener = readyCall[1] as (event: unknown) => void
      vi.advanceTimersByTime(1)

      // Why: a straggler handshake from a dying window must not reopen the gate (or trigger the destructive reconcile) for the new page.
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
      const handleRendererLoading = getMainFrameNavigationListener()
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      vi.advanceTimersByTime(1)

      // A timely handshake must cancel the reload watchdog so no orphaned ~10s timer lingers (forced-count guard can't catch it — the watchdog no-ops once ready).
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
      const handleRendererLoading = getMainFrameNavigationListener()
      // Drain the initial dispatcher-ready flush; the baseline is timer-free.
      vi.advanceTimersByTime(1)
      expect(vi.getTimerCount()).toBe(0)

      // A reload closes the gate and arms the ~10s self-heal watchdog on THIS registration's closure.
      handleRendererLoading()
      expect(vi.getTimerCount()).toBe(1)

      // Re-registering must cancel the prior closure's watchdog (cross-registration bridge) or it later force-opens a dead window's gate.
      registerPtyHandlers(mainWindow as never)
      expect(vi.getTimerCount()).toBe(0)

      // And no orphaned ~10s watchdog fires later (removing the bridge cancel turns this red).
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

      const sourceData = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\ready'
      mockProc.emitData(sourceData)

      // Why: the reply leaves the query's own turn so a still-cooked tty cannot
      // echo it back as text instead of delivering it to the agent (#12112).
      expect(mockProc.proc.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      expect(mockProc.proc.write).toHaveBeenCalledWith('\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
      expect(mockProc.proc.write).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'ready',
        rawLength: sourceData.length,
        transformed: true
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

      const sourceData = '\x1b]10;?;?\x1b\\ready'
      mockProc.emitData(sourceData)

      // Why: both slots of a duplicate-slot query leave the query's own turn too (#12112).
      expect(mockProc.proc.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      expect(mockProc.proc.write).toHaveBeenCalledWith('\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
      expect(mockProc.proc.write).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'ready',
        rawLength: sourceData.length,
        transformed: true
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

  it('accepts source-classified daemon startup spans before spawn resolves', async () => {
    vi.useFakeTimers()
    type ProviderData = {
      id: string
      data: string
      sequenceChars?: number
      transformed?: boolean
      seq?: number
    }
    let dataHandler: ((payload: ProviderData) => void) | null = null
    const write = vi.fn()
    const query = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\'
    const spawn = vi.fn(async (options: { sessionId?: string; startupIngress?: unknown }) => {
      const id = options.sessionId ?? 'daemon-pty'
      dataHandler?.({
        id,
        data: '',
        sequenceChars: query.length,
        transformed: true,
        seq: query.length
      })
      dataHandler?.({ id, data: 'daemon-ready' })
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
      onData: vi.fn((handler: (payload: ProviderData) => void) => {
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
      let seq = 0
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        onPtyData: vi.fn(
          (_id: string, _data: string, _at: number, rawLength: number) => (seq += rawLength)
        ),
        registerPty: vi.fn()
      }
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

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          startupIngress: expect.objectContaining({
            colors: { foreground: '#eeeeee', background: '#111111' },
            deadlineMs: 5_000
          })
        })
      )
      expect(write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'daemon-ready',
        seq: query.length + 'daemon-ready'.length,
        rawLength: query.length + 'daemon-ready'.length,
        transformed: true
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves source raw sequence metadata when a consumed query is batched', async () => {
    vi.useFakeTimers()
    type ProviderData = {
      id: string
      data: string
      sequenceChars?: number
      transformed?: boolean
      seq?: number
    }
    const providerEvents: {
      dataHandler?: (payload: ProviderData) => void
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
      onData: vi.fn((handler: (payload: ProviderData) => void) => {
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
      onPtyData: vi.fn((_id: string, data: string, _at: number, rawLength = data.length) => {
        seq += rawLength
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
      const query = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\'
      providerEvents.dataHandler?.({
        id: spawnResult.id,
        data: '',
        sequenceChars: query.length,
        transformed: true,
        seq: 'prefix'.length + query.length
      })
      providerEvents.dataHandler?.({ id: spawnResult.id, data: 'ready' })
      vi.advanceTimersByTime(2)

      expect(write).not.toHaveBeenCalled()
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'prefixready',
        seq: 'prefix'.length + query.length + 'ready'.length,
        rawLength: 'prefix'.length + query.length + 'ready'.length,
        transformed: true
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
      mainWindow.webContents.send.mockClear()

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

  it('defers reentrant new, unvisited, and same-partial output to the next drain round', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    const newProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc)
    spawnMock.mockReturnValueOnce(secondProc.proc)
    spawnMock.mockReturnValueOnce(newProc.proc)

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
      const newSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const firstChunk = 'x'.repeat(16 * 1024)
      const setActiveRendererPty = getPtySetActiveRendererPtyListener()
      let reentered = false
      mainWindow.webContents.send.mockImplementation(
        (channel: string, payload: { id?: string }) => {
          if (channel !== 'pty:data' || payload.id !== firstSpawn.id || reentered) {
            return
          }
          reentered = true
          firstProc.emitData('+same')
          secondProc.emitData('+append')
          newProc.emitData('new')
          setActiveRendererPty(null, { id: newSpawn.id, active: true })
        }
      )

      firstProc.emitData(`${firstChunk}tail`)
      secondProc.emitData('second')
      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls()).toEqual([['pty:data', { id: firstSpawn.id, data: firstChunk }]])

      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls().slice(1)).toEqual([
        ['pty:data', { id: newSpawn.id, data: 'new' }],
        ['pty:data', { id: secondSpawn.id, data: 'second+append' }]
      ])

      vi.advanceTimersByTime(1)
      expect(getPtyDataSendCalls().at(-1)).toEqual([
        'pty:data',
        { id: firstSpawn.id, data: 'tail+same' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('commits a partial remainder before notification-reentrant exit', async () => {
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
      })) as { id: string; incarnationId: string }
      const secondSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const firstChunk = 'x'.repeat(16 * 1024)
      mainWindow.webContents.send.mockClear()
      let exited = false
      mainWindow.webContents.send.mockImplementation(
        (channel: string, payload: { id?: string; data?: string }) => {
          if (
            channel === 'pty:data' &&
            payload.id === firstSpawn.id &&
            payload.data === firstChunk &&
            !exited
          ) {
            exited = true
            firstProc.emitExit(0)
          }
        }
      )

      firstProc.emitData(`${firstChunk}tail`)
      secondProc.emitData('next')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send.mock.calls).toEqual([
        ['pty:data', { id: firstSpawn.id, data: firstChunk }],
        ['pty:data', { id: firstSpawn.id, data: 'tail' }],
        ['pty:exit', { id: firstSpawn.id, code: 0, incarnationId: firstSpawn.incarnationId }],
        ['pty:data', { id: secondSpawn.id, data: 'next' }]
      ])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        rendererInFlightPtyCount: 1,
        rendererInFlightChars: 'next'.length,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts the open drain when renderer lifecycle clear reenters notification', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const detachedProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(detachedProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const firstSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })
      const handleRendererLoading = getMainFrameNavigationListener()
      let cleared = false
      mainWindow.webContents.send.mockImplementation(
        (channel: string, payload: { id?: string }) => {
          if (channel === 'pty:data' && payload.id === firstSpawn.id && !cleared) {
            cleared = true
            handleRendererLoading()
          }
        }
      )

      firstProc.emitData('first')
      detachedProc.emitData('must-not-send')
      vi.advanceTimersByTime(2)

      expect(getPtyDataSendCalls()).toEqual([['pty:data', { id: firstSpawn.id, data: 'first' }]])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0,
        flushScheduled: false,
        rendererPtyDispatcherReady: false
      })
      expect(vi.getTimerCount()).toBe(1)
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
        peakMaxPendingCharsByPty: 72 * 1024,
        peakRendererInFlightChars: 512 * 1024 + 'second-terminal-output'.length,
        peakMaxRendererInFlightCharsByPty: 512 * 1024,
        ackGatedFlushSkipCount: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not scan delivery maps for 1,000 ACKs across 100 tracked PTYs', () => {
    vi.useFakeTimers()
    const provider = installObservableDaemonTestProvider()

    try {
      registerPtyHandlers(mainWindow as never)
      const ptyIds = Array.from({ length: 100 }, (_, index) => `pressure-pty-${index}`)
      for (const id of ptyIds) {
        provider.emitData(id, 'a')
      }
      vi.runAllTimers()
      for (const id of ptyIds) {
        provider.emitData(id, 'b')
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 100,
        pendingChars: 100,
        rendererInFlightPtyCount: 100,
        rendererInFlightChars: 100
      })

      const ackData = getPtyAckDataListener()
      const mapValuesSpy = vi.spyOn(Map.prototype, 'values')
      let mapValuesCalls = 0
      try {
        for (let index = 0; index < 1_000; index++) {
          ackData(null, { id: ptyIds[0]!, processedChars: 1 })
        }
      } finally {
        mapValuesCalls = mapValuesSpy.mock.calls.length
        mapValuesSpy.mockRestore()
      }

      expect(mapValuesCalls).toBe(0)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 100,
        pendingChars: 100,
        rendererInFlightPtyCount: 99,
        rendererInFlightChars: 99
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

      // Saturate the renderer in-flight window (512 KB) with no ACKs — the frozen/starved-renderer shape from field reports.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 32; index++) {
        vi.advanceTimersByTime(1)
      }

      // Keep flooding past the 2 MB per-PTY pending cap; main must not buffer unboundedly (previously: unbounded string concat).
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

      // On recover+ACK, the flush must deliver the droppedOutput sentinel so the pane repaints from the main-owned snapshot.
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

      // Flood past the cap with a DSR probe and a mode-2031 withdrawal split at the chunk edge.
      mockProc.emitData(
        `${'y'.repeat(2 * 1024 * 1024)}\x1b[6n${'y'.repeat(1024 * 1024)}\x1b[?2031h prompt \x1b[?20`
      )
      // While latched, later queries and the withdrawal continuation must still be carved out.
      mockProc.emitData(`31l${'z'.repeat(32 * 1024)}\x1b[0c${'z'.repeat(32 * 1024)}`)

      mainWindow.webContents.send.mockClear()
      ackData(null, { id: spawn.id, charCount: 512 * 1024 })
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawn.id,
        data: '\x1b[6n\x1b[0c\x1b[?2031l',
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

      // Saturate the in-flight window with no ACKs, then buffer 3 MB — over the floor, under the scaled cap: retain, don't drop.
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

      // Flood in 64KB chunks like a `yes`-style producer honoring pause — node-pty pause() stops the fd read, so it stops emitting.
      const chunk = 'x'.repeat(64 * 1024)
      let chunks = 0
      while (provider.pauseProducer.mock.calls.length === 0 && chunks < 100) {
        provider.emitData('flood-pty', chunk)
        chunks++
      }

      // Pause fires exactly once, on the first chunk past the 256KB high watermark (the 5th 64KB chunk), not per chunk.
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)
      expect(provider.pauseProducer).toHaveBeenCalledWith('flood-pty')
      expect(chunks).toBe(5)
      // Bounded: main buffered at most HIGH + one chunk while paused.
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 320 * 1024,
        peakPendingChars: 320 * 1024
      })

      // Resume must fire exactly once at the 32KB low watermark, with no flapping across the 32-256KB hysteresis band.
      vi.runAllTimers()
      expect(provider.resumeProducer).toHaveBeenCalledTimes(1)
      expect(provider.resumeProducer).toHaveBeenCalledWith('flood-pty')
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({ pendingChars: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps negotiated source-credit overflow off the legacy PTY-global pause path', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      let modelSequence = 0
      const runtime = {
        setPtyController: vi.fn(),
        setRemoteTerminalSourceRangeConsumerHooks: vi.fn(),
        getPtyOutputSequence: vi.fn(() => modelSequence),
        onPtyData: vi.fn(
          (_id: string, data: string, _at: number, rawLength = data.length) =>
            (modelSequence += rawLength)
        ),
        acceptPtyDataBounded: vi.fn(
          (_id: string, _data: string, _at: number, rawLength: number) => {
            modelSequence += rawLength
            return { sequence: modelSequence, completion: Promise.resolve() }
          }
        )
      }
      registerPtyHandlers(mainWindow as never, runtime as never)
      mainWindow.webContents.send.mockClear()

      const sourceChunk = 's'.repeat(128 * 1024)
      for (let index = 0; index < 17; index++) {
        const sourceStartSu = index * sourceChunk.length
        await acceptSshPtyOutputData({
          id: 'source-credit-pty',
          data: sourceChunk,
          providerGeneration: 41,
          ptyIncarnation: 'source-incarnation',
          rawLength: sourceChunk.length,
          transformed: false,
          source: {
            relayPtyId: 'relay-source-pty',
            spanId: `source-token:${sourceStartSu}:${sourceStartSu + sourceChunk.length}`,
            clientGeneration: 2,
            ownerGeneration: 3,
            deliveryToken: 'source-token',
            sourceStartSu,
            sourceEndSu: sourceStartSu + sourceChunk.length
          }
        })
      }

      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 0
      })
      expect(provider.pauseProducer).not.toHaveBeenCalledWith('source-credit-pty')
      expect(provider.resumeProducer).not.toHaveBeenCalledWith('source-credit-pty')

      provider.emitData('legacy-pty', 'l'.repeat(320 * 1024))
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)
      expect(provider.pauseProducer).toHaveBeenCalledWith('legacy-pty')
      expect(provider.pauseProducer).not.toHaveBeenCalledWith('unrelated-pty')

      vi.runAllTimers()
      expect(provider.resumeProducer).toHaveBeenCalledTimes(1)
      expect(provider.resumeProducer).toHaveBeenCalledWith('legacy-pty')
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('pauses and resumes the exact SSH provider generation across reconnect replacement', async () => {
    vi.useFakeTimers()
    const completion = makeDeferred()
    let sequence = 0
    let captures = 0
    const runtime = {
      setPtyController: vi.fn(),
      setRemoteTerminalSourceRangeConsumerHooks: vi.fn(),
      getPtyOutputSequence: vi.fn(() => sequence),
      acceptPtyDataBounded: vi.fn((_id: string, _data: string, _at: number, rawLength: number) => {
        sequence += rawLength
        captures++
        return {
          sequence,
          completion: captures === 1 ? completion.promise : Promise.resolve()
        }
      })
    }
    const original = {
      providerGeneration: 41,
      hasPtyDeliveryPauseAdapter: () => true,
      pauseProducer: vi.fn(),
      resumeProducer: vi.fn()
    }
    const replacement = {
      providerGeneration: 42,
      hasPtyDeliveryPauseAdapter: () => true,
      pauseProducer: vi.fn(),
      resumeProducer: vi.fn()
    }
    const id = 'ssh:ssh-generation-replacement@@relay-pty'
    const receipts: Promise<unknown>[] = []

    try {
      registerPtyHandlers(mainWindow as never, runtime as never)
      registerSshPtyProvider('ssh-generation-replacement', original as never)
      const running = acceptSshPtyOutputData({
        id,
        data: 'a'.repeat(256 * 1024),
        providerGeneration: 41,
        ptyIncarnation: 'incarnation-41',
        rawLength: 256 * 1024,
        transformed: false
      })
      receipts.push(running)
      registerSshPtyProvider('ssh-generation-replacement', replacement as never)
      const pressured = acceptSshPtyOutputData({
        id,
        data: 'b',
        providerGeneration: 41,
        ptyIncarnation: 'incarnation-41',
        rawLength: 1,
        transformed: false
      })
      receipts.push(pressured)

      expect(original.pauseProducer).toHaveBeenCalledWith(id)
      expect(replacement.pauseProducer).not.toHaveBeenCalled()

      completion.resolve()
      await Promise.all([running, pressured])
      expect(original.resumeProducer).toHaveBeenCalledWith(id)
      expect(replacement.resumeProducer).not.toHaveBeenCalled()
    } finally {
      completion.resolve()
      await Promise.allSettled(receipts)
      closeSshPtyOutputGeneration(41, 'test-cleanup')
      unregisterSshPtyProvider('ssh-generation-replacement')
    }
  })

  it('rejects local data while an SSH renderer exit waits for projection settlement', async () => {
    const provider = installObservableDaemonTestProvider()
    let sequence = 0
    const runtime = {
      setPtyController: vi.fn(),
      setRemoteTerminalSourceRangeConsumerHooks: vi.fn(),
      getPtyOutputSequence: vi.fn(() => sequence),
      acceptPtyDataBounded: vi.fn((_id: string, _data: string, _at: number, rawLength: number) => {
        sequence += rawLength
        return { sequence, completion: Promise.resolve() }
      }),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn()
    }
    const id = 'ssh:exit-data-race@@relay-pty'

    registerPtyHandlers(mainWindow as never, runtime as never)
    mainWindow.webContents.send.mockClear()
    await acceptSshPtyOutputData({
      id,
      data: 'before-exit',
      providerGeneration: 51,
      ptyIncarnation: 'incarnation-51',
      rawLength: 'before-exit'.length,
      transformed: false
    })
    const exit = acceptSshPtyOutputExit({
      id,
      code: 0,
      providerGeneration: 51,
      ptyIncarnation: 'incarnation-51'
    })
    await Promise.resolve()

    provider.emitData(id, 'must-not-follow-exit')
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('pty:data', {
      id,
      data: 'must-not-follow-exit'
    })

    getPtyAckDataListener()(null, { id, processedChars: 'before-exit'.length })
    await exit
    expect(mainWindow.webContents.send.mock.calls.at(-1)).toEqual([
      'pty:exit',
      {
        id,
        code: 0,
        providerGeneration: 51,
        ptyIncarnation: 'incarnation-51'
      }
    ])
  })

  it('resumes a paused producer when the PTY exits before draining', async () => {
    vi.useFakeTimers()
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      mainWindow.webContents.send.mockClear()

      const finalPendingData = 'x'.repeat(320 * 1024)
      provider.emitData('flood-pty', finalPendingData)
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)

      // Exit while pending is above the low watermark: the exit path must release the pause, not leave a stale mark.
      provider.emitExit('flood-pty', 0)
      expect(provider.resumeProducer).toHaveBeenCalledTimes(1)
      expect(provider.resumeProducer).toHaveBeenCalledWith('flood-pty')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fences synchronous producer data and duplicate exit while releasing an exiting PTY', () => {
    vi.useFakeTimers()
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      mainWindow.webContents.send.mockClear()

      const finalPendingData = 'x'.repeat(320 * 1024)
      provider.emitData('flood-pty', finalPendingData)
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)
      provider.resumeProducer.mockImplementation((id: string) => {
        provider.emitData(id, 'must-not-follow-exit')
        provider.emitExit(id, 0)
      })

      provider.emitExit('flood-pty', 0)

      expect(provider.resumeProducer).toHaveBeenCalledTimes(1)
      expect(mainWindow.webContents.send.mock.calls).toEqual([
        ['pty:data', { id: 'flood-pty', data: finalPendingData }],
        ['pty:exit', { id: 'flood-pty', code: 0 }]
      ])
      expect(
        getPtyDataSendCalls().some(
          (call) => (call[1] as { data?: string } | undefined)?.data === 'must-not-follow-exit'
        )
      ).toBe(false)
      expect(
        mainWindow.webContents.send.mock.calls.filter((call) => call[0] === 'pty:exit')
      ).toHaveLength(1)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a complete payload after a synchronous renderer send failure', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      mainWindow.webContents.send.mockClear()
      let failed = false
      let markerFailed = false
      mainWindow.webContents.send.mockImplementation(
        (channel: string, payload: { id?: string }) => {
          if (channel === 'pty:data' && payload.id === 'send-fail-complete' && !failed) {
            failed = true
            throw new Error('synthetic send failure')
          }
          if (channel === 'pty:modelRestoreNeeded' && !markerFailed) {
            markerFailed = true
            throw new Error('synthetic marker failure')
          }
        }
      )

      provider.emitData('send-fail-complete', 'lost-once')
      vi.advanceTimersByTime(2)

      expect(getPtyDataSendCalls()).toEqual([
        ['pty:data', { id: 'send-fail-complete', data: 'lost-once' }]
      ])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        pendingChars: 0,
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)

      provider.emitData('send-fail-complete', 'recovery')
      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls()).toEqual([
        ['pty:data', { id: 'send-fail-complete', data: 'lost-once' }],
        ['pty:data', { id: 'send-fail-complete', data: 'recovery' }]
      ])
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
        id: 'send-fail-complete',
        reason: 'delivery-heal'
      })
      provider.emitData('send-fail-complete', 'after-marker-failure')
      vi.advanceTimersByTime(2)
      expect(
        mainWindow.webContents.send.mock.calls.filter(
          (call) => call[0] === 'pty:modelRestoreNeeded'
        )
      ).toHaveLength(2)
      expect(getPtyDataSendCalls().at(-1)).toEqual([
        'pty:data',
        { id: 'send-fail-complete', data: 'after-marker-failure' }
      ])
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('keeps only a partial remainder after a synchronous renderer send failure', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      mainWindow.webContents.send.mockClear()
      const firstChunk = 'x'.repeat(16 * 1024)
      let failed = false
      mainWindow.webContents.send.mockImplementation((channel: string) => {
        if (channel === 'pty:data' && !failed) {
          failed = true
          throw new Error('synthetic send failure')
        }
      })

      provider.emitData('send-fail-partial', `${firstChunk}tail`)
      vi.advanceTimersByTime(2)

      expect(getPtyDataSendCalls()).toEqual([
        ['pty:data', { id: 'send-fail-partial', data: firstChunk }]
      ])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 4,
        rendererInFlightChars: 0,
        flushScheduled: true
      })
      expect(vi.getTimerCount()).toBe(1)

      vi.advanceTimersByTime(1)
      expect(getPtyDataSendCalls()).toEqual([
        ['pty:data', { id: 'send-fail-partial', data: firstChunk }],
        ['pty:data', { id: 'send-fail-partial', data: 'tail' }]
      ])
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
        id: 'send-fail-partial',
        reason: 'delivery-heal'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        rendererInFlightChars: 4,
        flushScheduled: false
      })
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('clears failed-delivery restore state when the renderer lifecycle resets', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      const resetRenderer = getMainFrameNavigationListener()
      const readyRenderer = getPtyRendererDispatcherReadyListener()
      let failed = false
      mainWindow.webContents.send.mockImplementation((channel: string) => {
        if (channel === 'pty:data' && !failed) {
          failed = true
          throw new Error('synthetic send failure')
        }
      })

      provider.emitData('send-fail-reset', 'lost-once')
      vi.advanceTimersByTime(2)
      resetRenderer()
      readyRenderer()
      mainWindow.webContents.send.mockClear()
      provider.emitData('send-fail-reset', 'repainted-page-data')
      vi.advanceTimersByTime(2)

      expect(getPtyDataSendCalls()).toEqual([
        ['pty:data', { id: 'send-fail-reset', data: 'repainted-page-data' }]
      ])
      expect(
        mainWindow.webContents.send.mock.calls.filter(
          (call) => call[0] === 'pty:modelRestoreNeeded'
        )
      ).toHaveLength(0)
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('commits interactive bypass removal and producer flow after a synchronous send failure', async () => {
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
      const writePty = getPtyWriteListener()
      mainWindow.webContents.send.mockClear()
      let failed = false
      mainWindow.webContents.send.mockImplementation((channel: string) => {
        if (channel === 'pty:data' && !failed) {
          failed = true
          throw new Error('synthetic send failure')
        }
      })

      mockProc.emitData('older-')
      writePty(mainWindowIpcEvent, { id: spawn.id, data: 'x' })
      mockProc.emitData('redraw')

      expect(getPtyDataSendCalls()).toEqual([['pty:data', { id: spawn.id, data: 'older-redraw' }]])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        pendingChars: 0,
        rendererInFlightChars: 0,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)

      mockProc.emitData('recovery')
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
        id: spawn.id,
        reason: 'delivery-heal'
      })
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('cleans up and emits exit once when the final data send fails synchronously', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      const pending = 'x'.repeat(320 * 1024)
      provider.emitData('send-fail-exit', pending)
      expect(provider.pauseProducer).toHaveBeenCalledWith('send-fail-exit')
      mainWindow.webContents.send.mockClear()
      mainWindow.webContents.send.mockImplementation((channel: string) => {
        if (channel === 'pty:data') {
          throw new Error('synthetic send failure')
        }
      })

      provider.emitExit('send-fail-exit', 7)

      expect(getPtyDataSendCalls()).toEqual([['pty:data', { id: 'send-fail-exit', data: pending }]])
      expect(
        mainWindow.webContents.send.mock.calls.filter((call) => call[0] === 'pty:exit')
      ).toEqual([['pty:exit', { id: 'send-fail-exit', code: 7 }]])
      expect(
        mainWindow.webContents.send.mock.calls.filter(
          (call) => call[0] === 'pty:modelRestoreNeeded'
        )
      ).toHaveLength(0)
      expect(provider.resumeProducer).toHaveBeenCalledWith('send-fail-exit')
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        pendingChars: 0,
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('delivers a pending-cap sentinel before exit and clears its pending timer', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      provider.emitData('flood-pty', 'x'.repeat(3 * 1024 * 1024))
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 0,
        flushScheduled: true
      })
      mainWindow.webContents.send.mockClear()

      provider.emitExit('flood-pty', 0)

      expect(mainWindow.webContents.send.mock.calls).toEqual([
        ['pty:data', { id: 'flood-pty', data: '', droppedOutput: true }],
        ['pty:exit', { id: 'flood-pty', code: 0 }]
      ])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      errorSpy.mockRestore()
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

  /** Saturates one PTY to its 512 KiB in-flight cap; leaves 88 KiB pending and no timers scheduled. */
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

      // Every per-chunk ACK was lost, but the next ACK carries the full cumulative total — the debt clears without any timer or reset.
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

  it('keeps zero, duplicate, and stale ACKs to one legacy no-write timer', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)
      const ackData = getPtyAckDataListener()
      expect(getPtyDataSendCalls()).toHaveLength(32)
      expect(vi.getTimerCount()).toBe(0)

      ackData(null, { id: spawnResult.id, processedChars: 0 })
      expect(getPtyRendererDeliveryDebugSnapshot().flushScheduled).toBe(true)
      expect(vi.getTimerCount()).toBe(1)
      ackData(null, { id: spawnResult.id, processedChars: 0 })
      ackData(null, { id: spawnResult.id, processedChars: -1 })
      expect(vi.getTimerCount()).toBe(1)

      vi.runOnlyPendingTimers()
      expect(getPtyDataSendCalls()).toHaveLength(32)
      expect(getPtyRendererDeliveryDebugSnapshot().flushScheduled).toBe(false)
      expect(vi.getTimerCount()).toBe(0)

      ackData(null, { id: spawnResult.id, processedChars: 16 * 1024 })
      vi.runOnlyPendingTimers()
      expect(getPtyDataSendCalls()).toHaveLength(33)
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

      // Why: cumulative totals clamp to what main sent; a replayed total credits SSH/relay flow control 0, not duplicate bytes.
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

      // Reconciled gate lets held pendingData flush again (one 2ms batch window = one 16KB slice).
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

      // Cleared flag lets the next gated arrival probe again, but a still-silent renderer won't spam a second warn.
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
      // Only the probe's hygiene timeout remains; the dispatcher-ready handshake already drained the pending flush.
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
  // Field wedge (v1.4.121-rc.0): push dead but invoke alive, so the push-riding resync probe can't answer; this invoke lane recovers.

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

      // Lost-ACK variant: renderer processed everything, only ACKs vanished; a plain report (no heal) must drain the debt.
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

      // 512 KiB never-received is written off; the 88 KiB pending is dropped too (snapshot restore covers everything at/before the marker).
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

  it('reactivates globally blocked work immediately after a delivery writeoff', () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      const bulkIds = Array.from({ length: 16 }, (_, index) => `writeoff-bulk-${index}`)
      mainWindow.webContents.send.mockClear()
      for (const id of bulkIds) {
        provider.emitData(id, 'x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 8 * 1024 * 1024,
        flushScheduled: false
      })

      provider.emitData('writeoff-held', 'held')
      vi.advanceTimersByTime(2)
      expect(
        getPtyDataSendCalls().some(
          (call) => (call[1] as { id?: string } | undefined)?.id === 'writeoff-held'
        )
      ).toBe(false)
      expect(getPtyRendererDeliveryDebugSnapshot().flushScheduled).toBe(false)

      reportRendererDeliveryState({
        receivedCharsByPty: {},
        processedCharsByPty: {},
        heal: true,
        rendererPtyDataListenerCount: 1
      })
      expect(getPtyRendererDeliveryDebugSnapshot().flushScheduled).toBe(true)
      vi.advanceTimersByTime(0)

      expect(getPtyDataSendCalls().at(-1)).toEqual([
        'pty:data',
        { id: 'writeoff-held', data: 'held' }
      ])
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

      // Parse backpressure, not a wedge: ACK credit is deferred to the scheduler consume point and still repays.
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

      // A pty still round-trips ACKs, so the channel isn't dead — a heal must not destroy accounting.
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
      const handleRendererLoading = getMainFrameNavigationListener()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightPtyCount: 1,
        rendererInFlightChars: 512 * 1024
      })

      handleRendererLoading()

      // Why: reload kills the dispatcher that would ACK, so stale counters would gate PTYs in the fresh renderer forever.
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0
      })
      // Main holds sends until the replacement page confirms its dispatcher; the reset arms a bounded handshake watchdog.
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

      // Why: stale/duplicated renderer ACKs must not over-credit SSH/relay flow control beyond bytes main sent.
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
      // Why: reserve-exhausted send stays gated, and the fully gated arrival emits one delivery resync probe (not pty:data).
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

  it('reactivates every globally blocked PTY when an exit releases renderer credit', async () => {
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
      mainWindow.webContents.send.mockClear()
      for (const proc of procs) {
        proc.emitData('x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(getPtyDataSendCalls()).toHaveLength(512)
      expect(vi.getTimerCount()).toBe(0)

      mainWindow.webContents.send.mockClear()
      procs[0]!.emitExit(0)
      const exitIndex = mainWindow.webContents.send.mock.calls.findIndex(
        (call) => call[0] === 'pty:exit'
      )
      expect(exitIndex).toBeGreaterThanOrEqual(0)
      vi.advanceTimersByTime(0)

      expect(
        mainWindow.webContents.send.mock.calls
          .slice(exitIndex + 1)
          .some(
            (call) =>
              call[0] === 'pty:data' &&
              (call[1] as { id?: string } | undefined)?.id !== spawns[0]!.id
          )
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('wakes blocked PTYs when a zero-write hidden drop reentrantly releases exit credit', async () => {
    vi.useFakeTimers()
    const bulkProcs = Array.from({ length: 16 }, () => createMockProc())
    const hiddenProc = createMockProc()
    const heldProc = createMockProc()
    for (const proc of [...bulkProcs, hiddenProc, heldProc]) {
      spawnMock.mockReturnValueOnce(proc.proc)
    }

    try {
      registerPtyHandlers(mainWindow as never)
      const bulkSpawns: { id: string }[] = []
      for (const _proc of bulkProcs) {
        bulkSpawns.push(
          (await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            cwd: '/tmp'
          })) as { id: string }
        )
      }
      const hiddenSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })

      for (const proc of bulkProcs) {
        proc.emitData('x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 8 * 1024 * 1024,
        flushScheduled: false
      })

      const setHidden = getPtySetHiddenRendererPtyListener()
      const setInterest = getPtySetDeliveryInterestListener()
      setHidden(null, { id: hiddenSpawn.id, hidden: true })
      setInterest(null, { id: hiddenSpawn.id, interested: true })
      hiddenProc.emitData('drop-without-write')
      heldProc.emitData('held')
      setInterest(null, { id: hiddenSpawn.id, interested: false })
      mainWindow.webContents.send.mockClear()
      let reentered = false
      mainWindow.webContents.send.mockImplementation(
        (channel: string, payload: { id?: string }) => {
          if (channel === 'pty:modelRestoreNeeded' && payload.id === hiddenSpawn.id && !reentered) {
            reentered = true
            bulkProcs[0]!.emitExit(0)
          }
        }
      )

      vi.advanceTimersByTime(2)

      const exitIndex = mainWindow.webContents.send.mock.calls.findIndex(
        (call) => call[0] === 'pty:exit'
      )
      expect(exitIndex).toBeGreaterThanOrEqual(0)
      expect(getPtyRendererDeliveryDebugSnapshot().flushScheduled).toBe(true)
      vi.advanceTimersByTime(1)
      expect(
        mainWindow.webContents.send.mock.calls
          .slice(exitIndex + 1)
          .some(
            (call) =>
              call[0] === 'pty:data' &&
              (call[1] as { id?: string } | undefined)?.id !== bulkSpawns[0]!.id
          )
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reactivate globally blocked PTYs when exit releases no prior credit', async () => {
    vi.useFakeTimers()
    const bulkProcs = Array.from({ length: 16 }, () => createMockProc())
    const finalProc = createMockProc()
    const heldProc = createMockProc()
    for (const proc of [...bulkProcs, finalProc, heldProc]) {
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
      const finalSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string; incarnationId: string }
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })

      for (const proc of bulkProcs) {
        proc.emitData('x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 8 * 1024 * 1024,
        flushScheduled: false
      })

      finalProc.emitData('final-tail')
      heldProc.emitData('held')
      vi.advanceTimersByTime(2)
      expect(getPtyRendererDeliveryDebugSnapshot().flushScheduled).toBe(false)
      const timerCountBeforeExit = vi.getTimerCount()
      mainWindow.webContents.send.mockClear()

      finalProc.emitExit(0)

      expect(mainWindow.webContents.send.mock.calls).toEqual([
        ['pty:data', { id: finalSpawn.id, data: 'final-tail' }],
        ['pty:exit', { id: finalSpawn.id, code: 0, incarnationId: finalSpawn.incarnationId }]
      ])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 8 * 1024 * 1024,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(timerCountBeforeExit)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not schedule a teardown-only flush for the last active blocked PTY', async () => {
    vi.useFakeTimers()
    const proc = createMockProc()
    spawnMock.mockReturnValue(proc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      getPtySetActiveRendererPtyListener()(null, { id: spawn.id, active: true })
      proc.emitData('x'.repeat(1200 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 80; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)

      proc.emitExit(0)

      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)
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

      // Why: the fully gated arrival also emits a delivery resync probe, so count pty:data sends not raw webContents.send.
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
          'hidden output'.length,
          undefined
        )
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        // Why out-of-band: an in-band empty pty:data chunk is ambiguous with chunks fully consumed by renderer OSC-9999 stripping.
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
      // Why: field snapshot v1.4.124-rc.2.perf — aggregates couldn't tell if the visible pane was hidden-gated; overlap counter + warn makes it decisive.
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

        // The two visibility signals contradict: pane reports visible while the hidden-delivery gate still holds it.
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
        // Why redaction is pinned: daemon session ids embed worktree paths, so the report must never carry the raw id.
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

    it('drops queued hidden data when interest ends before dispatcher readiness', async () => {
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
        const setActive = getPtySetActiveRendererPtyListener()
        getMainFrameNavigationListener()()
        mainWindow.webContents.send.mockClear()

        setHidden(null, { id: spawnResult.id, hidden: true })
        setInterest(null, { id: spawnResult.id, interested: true })
        mockProc.emitData('boot-window sidecar bytes')
        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).not.toHaveBeenCalled()
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          pendingPtyCount: 1,
          rendererPtyDispatcherReady: false,
          ackGatedFlushSkipCount: 0
        })

        const timerCountBeforeNoops = vi.getTimerCount()
        setHidden(null, { id: spawnResult.id, hidden: true })
        setInterest(null, { id: spawnResult.id, interested: true })
        setActive(null, { id: spawnResult.id, active: false })
        expect(vi.getTimerCount()).toBe(timerCountBeforeNoops)

        setInterest(null, { id: spawnResult.id, interested: false })
        vi.advanceTimersByTime(0)

        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'hidden-drop'
        })
        expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
          pendingPtyCount: 0,
          rendererPtyDispatcherReady: false,
          ackGatedFlushSkipCount: 0
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

    it.each(['terminalHiddenDeliveryGate', 'terminalMainSideEffectAuthority'] as const)(
      'reevaluates blocked hidden data when the live %s setting enables the derived gate',
      async (settingName) => {
        vi.useFakeTimers()
        const mockProc = createMockProc()
        spawnMock.mockReturnValue(mockProc.proc)
        const settings = {
          terminalHiddenDeliveryGate: true,
          terminalMainSideEffectAuthority: true
        }
        settings[settingName] = false

        try {
          registerPtyHandlers(mainWindow as never, undefined, undefined, (() => settings) as never)
          const spawnResult = (await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            cwd: '/tmp'
          })) as { id: string }
          getMainFrameNavigationListener()()
          getPtySetHiddenRendererPtyListener()(null, { id: spawnResult.id, hidden: true })
          mainWindow.webContents.send.mockClear()
          mockProc.emitData('blocked while gate disabled')
          vi.advanceTimersByTime(2)
          expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
            pendingPtyCount: 1,
            rendererPtyDispatcherReady: false
          })

          settings[settingName] = true
          getPtyAckDataListener()(null, { id: spawnResult.id, processedChars: 0 })
          vi.advanceTimersByTime(0)

          expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
            id: spawnResult.id,
            reason: 'hidden-drop'
          })
          expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
            pendingPtyCount: 0,
            rendererPtyDispatcherReady: false
          })
        } finally {
          vi.useRealTimers()
        }
      }
    )

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

        // Why: a renderer reload can replace the view that latched restore-needed; unhide repeats the marker so the live view heals.
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

        // Why: a hidden remount (tab move, parking handoff) re-marks without an unhide, so re-marking must NOT erase drop memory.
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
        // Why daemon provider: survives reloads and keeps orphan-kill off this webContents, so 'did-finish-load' means gate reset only.
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

        // Renderer reload: hidden marks die with the old renderer, but dropped bytes were never restored — memory must survive.
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

        // Why: the renderer reload killed the sidecar's ref count without a release IPC — the leaked hold must not force-feed the PTY forever.
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
    // terminal-query-authority.md §races: hidden-at-spawn marks the PTY before byte one, closing the spawn-time DA1-loss window.
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

        // Daemon PTYs can emit prompt bytes before spawn() resolves, so the pre-spawn mark must already gate them.
        expect(isHiddenRendererPty('daemon-session')).toBe(true)
        daemon.emitData('daemon-session', 'pre-spawn prompt\x1b[c')
        vi.advanceTimersByTime(50)
        expect(runtime.onPtyData).toHaveBeenCalledWith(
          'daemon-session',
          'pre-spawn prompt\x1b[c',
          expect.any(Number),
          'pre-spawn prompt\x1b[c'.length,
          undefined
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
      // End-to-end through a REAL runtime: spawn-marked → first chunk dropped → emulator parses query → replies; main answers, the renderer never saw the bytes.
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

      // 3 MB in one entry: the scrollback-scaled cap (2 MB default) drops to O(1) memory; one restore marker fires, droppedOutput routes to the snapshot repaint.
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
      // Why: the pending cap ships independently of the gate (#7150) — droppedOutput repaint survives kill switches; only the restore marker is switch-scoped.
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

      expect(result).toEqual({
        id: expect.any(String),
        pid: 12345,
        incarnationId: expect.any(String)
      })
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

  it('asks the renderer to remount when the provider rejects a stale daemon write', async () => {
    const write = vi.fn(() => {
      throw new PtyWriteUnavailableError('daemon generation lost')
    })
    installDaemonTestProvider({ write })
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    mainWindow.webContents.send.mockClear()

    getPtyWriteListener()(mainWindowIpcEvent, { id: result.id, data: 'x' })

    expect(write).toHaveBeenCalledWith(result.id, 'x')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:writeUnavailable', {
      id: result.id
    })
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

    // Field failure (Discord #performance / #2836): a pane can render with a ptyId whose ownership is gone while the PTY lives, so keystrokes vanish silently.
    deletePtyOwnership(result.id)
    write(mainWindowIpcEvent, { id: result.id, data: 'dropped' })
    expect(mockProc.proc.write).not.toHaveBeenCalledWith('dropped')

    // pty:listSessions rebuilds ownership from provider sessions — the revival lever the frozen-pane e2e probes depend on.
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

  it('synchronizes runtime output sequencing from a provider reattach snapshot', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({
        id: 'pty-restored',
        isReattach: true,
        providerSequence: { value: 900, generation: 'continued' as const }
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
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      getPtyOutputSequence: vi.fn().mockReturnValue(7),
      synchronizePtyOutputSequenceFromProvider: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => null),
      preAllocateHandleForPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    expect(runtime.synchronizePtyOutputSequenceFromProvider).toHaveBeenCalledWith(
      'pty-restored',
      { value: 900, generation: 'continued' },
      7
    )
  })

  it('records the launch Codex account for a fresh spawn but not for a reattach', async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-fresh' })
      .mockResolvedValueOnce({ id: 'pty-reattached', isReattach: true })
    setLocalPtyProvider({
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const getSettings = vi.fn().mockReturnValue({ activeCodexManagedAccountId: 'account-a' })
    registerPtyHandlers(mainWindow as never, undefined, undefined, getSettings as never)

    const nativeCodexEnv = { CODEX_HOME: '', ORCA_CODEX_HOME: '' }
    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: nativeCodexEnv })
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      env: nativeCodexEnv,
      sessionId: 'pty-reattached'
    })

    // Why: a reattached shell keeps the CODEX_HOME baked in at its original
    // spawn, so re-recording it under the current selection would erase the only
    // evidence that the pane is stale.
    expect(recordCodexPaneAccountMock.mock.calls).toEqual([
      ['pty-fresh', { selectionKey: 'host', accountId: 'account-a', homeRoute: 'real-home' }]
    ])
  })

  posixOnlyIt(
    'does not guess route provenance for a pane-local shell startup CODEX_HOME',
    async () => {
      setLocalPtyProvider({
        spawn: vi.fn(async () => ({ id: 'pty-custom-home' })),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        shutdown: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        listProcesses: vi.fn(async () => []),
        getForegroundProcess: vi.fn(async () => null)
      } as never)
      readFileSyncMock.mockImplementation((path: string) =>
        path === '/pane-home/.zshrc' ? 'export CODEX_HOME="$HOME/custom-codex-home"\n' : ''
      )
      const getSettings = vi.fn().mockReturnValue({ activeCodexManagedAccountId: null })
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        () => TEST_CODEX_HOME,
        getSettings as never
      )

      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        env: {
          CODEX_HOME: '',
          ORCA_CODEX_HOME: '',
          HOME: '/pane-home',
          SHELL: '/bin/zsh'
        }
      })

      expect(recordCodexPaneAccountMock).toHaveBeenCalledWith('pty-custom-home', {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'custom-home'
      })
    }
  )

  it('records route provenance for a process-wide CODEX_HOME', async () => {
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = '/process/custom-codex-home'
    try {
      setLocalPtyProvider({
        spawn: vi.fn(async () => ({ id: 'pty-process-home' })),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        shutdown: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        listProcesses: vi.fn(async () => []),
        getForegroundProcess: vi.fn(async () => null)
      } as never)
      const getSettings = vi.fn().mockReturnValue({ activeCodexManagedAccountId: null })
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        () => TEST_CODEX_HOME,
        getSettings as never
      )

      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        env: { CODEX_HOME: '/process/custom-codex-home' }
      })

      expect(recordCodexPaneAccountMock).toHaveBeenCalledWith('pty-process-home', {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'shared-home',
        environmentHomeOverride: { codexHome: '/process/custom-codex-home' }
      })
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
    }
  })

  it('does not guess route provenance for a pane-local environment CODEX_HOME', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: 'pty-pane-env-home' })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const getSettings = vi.fn().mockReturnValue({ activeCodexManagedAccountId: null })
    registerPtyHandlers(mainWindow as never, undefined, () => TEST_CODEX_HOME, getSettings as never)

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      env: { CODEX_HOME: '/pane/custom-codex-home' }
    })

    expect(recordCodexPaneAccountMock).toHaveBeenCalledWith('pty-pane-env-home', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'custom-home'
    })
  })

  it('does not resume under another account when the origin auth stays unavailable', async () => {
    vi.useFakeTimers()
    const spawn = vi.fn(async () => ({ id: 'pty-must-not-spawn' }))
    setLocalPtyProvider({
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath.endsWith('auth.json')) {
        throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
      }
      return ''
    })
    const resolveHome = vi.fn(() => '/managed/current/home')
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      resolveHome,
      (() => ({
        codexManagedAccounts: [
          { id: 'account-a', managedHomePath: '/managed/origin/home' },
          { id: 'account-b', managedHomePath: '/managed/current/home' }
        ]
      })) as never,
      undefined,
      undefined,
      {
        prepareCodexSessionResume: async () => ({
          outcome: 'resume' as const,
          codexHomePath: '/managed/origin/home'
        })
      }
    )

    const launch = handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      command: 'codex resume session-a',
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
      launchAgent: 'codex',
      resumeProviderSession: {
        key: 'session_id',
        id: 'session-a',
        transcriptPath: '/managed/origin/home/sessions/2026/07/20/rollout-a.jsonl'
      }
    })
    const rejection = expect(launch).rejects.toThrow(
      'The Codex account credentials for this session are temporarily unavailable. Try opening the terminal again.'
    )
    await vi.advanceTimersByTimeAsync(2_000)
    await rejection

    expect(resolveHome).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(recordCodexPaneAccountMock).not.toHaveBeenCalled()
  })

  it('records the origin account a resumed Codex pane is pinned to', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: 'pty-resumed' })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const getSettings = vi.fn().mockReturnValue({
      activeCodexManagedAccountId: 'account-b',
      codexManagedAccounts: [
        { id: 'account-a', managedHomePath: '/managed/origin/home' },
        { id: 'account-b', managedHomePath: '/managed/current/home' }
      ]
    })
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      vi.fn(() => '/managed/current/home'),
      getSettings as never,
      undefined,
      undefined,
      {
        prepareCodexSessionResume: async () => ({
          outcome: 'resume' as const,
          codexHomePath: '/managed/origin/home'
        })
      }
    )
    readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)

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

    // Why: the resume deliberately overrides the selection, so the pane really
    // is on account-a. Recording that is what makes the restart prompt appear.
    expect(recordCodexPaneAccountMock.mock.calls).toEqual([
      ['pty-resumed', { selectionKey: 'host', accountId: 'account-a', homeRoute: 'account-home' }]
    ])
    expect(readFileSyncMock).toHaveBeenCalledWith('/managed/origin/home/auth.json', 'utf8')
    expect(forgetCodexPaneAccountMock).not.toHaveBeenCalled()
  })

  it('leaves a resumed Codex pane unattributed when no account owns its home', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: 'pty-resumed' })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const getSettings = vi.fn().mockReturnValue({
      activeCodexManagedAccountId: 'account-b',
      codexManagedAccounts: [{ id: 'account-b', managedHomePath: '/managed/current/home' }]
    })
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      vi.fn(() => '/managed/current/home'),
      getSettings as never,
      undefined,
      undefined,
      {
        prepareCodexSessionResume: async () => ({
          outcome: 'resume' as const,
          codexHomePath: '/managed/shared-mirror/home'
        })
      }
    )

    await handlers.get('pty:spawn')!(null, {
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

    // Why: an unowned home cannot be named, so guessing here would raise a
    // restart notice that blocks a correctly-signed-in pane's input.
    expect(recordCodexPaneAccountMock).not.toHaveBeenCalled()
    expect(forgetCodexPaneAccountMock).toHaveBeenCalledWith('pty-resumed')
  })

  // Why: the runtime controller is the CLI/relay resume path, and it repeats the
  // same recording call the ipc handler makes. Without its own coverage a revert
  // there is invisible.
  it('records the origin account for a resumed Codex pane spawned by the runtime controller', async () => {
    type RuntimeSpawnController = {
      spawn(args: Record<string, unknown>): Promise<{ id: string }>
    }
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: 'pty-runtime-resumed' })),
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
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    const getSettings = vi.fn().mockReturnValue({
      activeCodexManagedAccountId: 'account-b',
      codexManagedAccounts: [
        { id: 'account-a', managedHomePath: '/managed/origin/home' },
        { id: 'account-b', managedHomePath: '/managed/current/home' }
      ]
    })
    handlers.clear()
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      vi.fn(() => '/managed/current/home'),
      getSettings as never,
      undefined,
      undefined,
      {
        prepareCodexSessionResume: async () => ({
          outcome: 'resume' as const,
          codexHomePath: '/managed/origin/home'
        })
      }
    )
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController
    readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)

    await controller.spawn({
      cols: 80,
      rows: 24,
      worktreeId: 'wt-runtime',
      command: 'codex resume session-a',
      launchAgent: 'codex',
      resumeProviderSession: {
        key: 'session_id',
        id: 'session-a',
        transcriptPath: '/managed/origin/home/sessions/2026/07/20/rollout-a.jsonl'
      }
    })

    expect(recordCodexPaneAccountMock.mock.calls).toEqual([
      [
        'pty-runtime-resumed',
        { selectionKey: 'host', accountId: 'account-a', homeRoute: 'account-home' }
      ]
    ])
    expect(readFileSyncMock).toHaveBeenCalledWith('/managed/origin/home/auth.json', 'utf8')
    expect(forgetCodexPaneAccountMock).not.toHaveBeenCalled()
  })

  it('leaves a runtime-controller resumed Codex pane unattributed when no account owns its home', async () => {
    type RuntimeSpawnController = {
      spawn(args: Record<string, unknown>): Promise<{ id: string }>
    }
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: 'pty-runtime-resumed' })),
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
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    const getSettings = vi.fn().mockReturnValue({
      activeCodexManagedAccountId: 'account-b',
      codexManagedAccounts: [{ id: 'account-b', managedHomePath: '/managed/current/home' }]
    })
    handlers.clear()
    const resolveHome = vi.fn(() => '/managed/shared-mirror/home')
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      resolveHome,
      getSettings as never,
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
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

    await controller.spawn({
      cols: 80,
      rows: 24,
      worktreeId: 'wt-runtime',
      command: 'codex resume session-a',
      launchAgent: 'codex',
      resumeProviderSession: {
        key: 'session_id',
        id: 'session-a',
        transcriptPath: '/managed/shared-mirror/home/sessions/2026/07/20/rollout-a.jsonl'
      }
    })

    expect(resolveHome).toHaveBeenCalledTimes(1)
    expect(recordCodexPaneAccountMock).not.toHaveBeenCalled()
    expect(forgetCodexPaneAccountMock).toHaveBeenCalledWith('pty-runtime-resumed')
  })

  it('seeds cold restore at recovered dimensions with a legacy dimensionless fallback', async () => {
    const oscLinks = [{ row: 0, startCol: 0, endCol: 8, uri: 'https://example.com/restored' }]
    const coldRestore = {
      scrollback: 'restored history\r\n',
      cwd: '/projects/restored',
      cols: 132,
      rows: 43,
      oscLinks
    }
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-cold-restore', coldRestore })
      .mockResolvedValueOnce({
        id: 'pty-legacy-cold-restore',
        coldRestore: { scrollback: 'legacy history\r\n', cwd: '/projects/legacy' }
      })
    setLocalPtyProvider({
      spawn,
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

    expect(runtime.seedHeadlessTerminal).toHaveBeenNthCalledWith(
      1,
      'pty-cold-restore',
      'restored history\r\n',
      { cols: 132, rows: 43 },
      { cwd: '/projects/restored', oscLinks, preferProviderIfExisting: true }
    )

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    expect(runtime.seedHeadlessTerminal).toHaveBeenNthCalledWith(
      2,
      'pty-legacy-cold-restore',
      'legacy history\r\n',
      undefined,
      { cwd: '/projects/legacy', oscLinks: undefined, preferProviderIfExisting: true }
    )
  })

  it('seeds the headless emulator from an SSH relay reattach replay', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({
        id: 'pty-ssh-reattach',
        isReattach: true,
        replay: 'relay history\r\n'
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
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'handle-ssh-reattach'),
      registerPreAllocatedHandleForPty: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    // Why: without this seed main's model would be a strict suffix of what the renderer painted, and a later park-reveal would restore the fragment.
    expect(runtime.seedHeadlessTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.seedHeadlessTerminal).toHaveBeenCalledWith(
      'pty-ssh-reattach',
      'relay history\r\n'
    )
  })

  // STA repro (post-restart blind orchestrator): reattach restore payloads
  // arrive as spawn RPC results, never through onPtyData, so without record
  // seeding `terminal list` reported connected terminals with empty
  // title/preview/lastOutputAt after every relaunch and `terminal read`
  // returned a zero-line tail for a running session.
  it('leaves the runtime reporting preview and title after a reattach spawn (restart restore)', async () => {
    const worktreeId = 'repo-restore::/tmp/restore-records'
    const tabId = 'tab-restore-records'
    const leafId = '55555555-5555-4555-8555-555555555555'
    const ptyId = `${worktreeId}@@session-restore-1`
    const session = getDefaultWorkspaceSession()
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => session,
      setWorkspaceSession: () => {},
      getRepos: () => [
        {
          id: 'repo-restore',
          path: '/tmp/restore-records',
          displayName: 'restore',
          badgeColor: '#000000',
          addedAt: 0
        }
      ],
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: () => undefined as never,
      removeWorktreeMeta: () => {},
      getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
      getProjects: () => []
    } as never)
    runtime.attachWindow(1)
    // The restored window graph still knows the persisted ptyId binding.
    runtime.syncWindowGraph(1, {
      tabs: [{ tabId, worktreeId, title: '', activeLeafId: leafId, layout: null }],
      leaves: [{ tabId, worktreeId, leafId, paneRuntimeId: 1, ptyId, paneTitle: null, title: '' }]
    })
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({
        id: ptyId,
        isReattach: true,
        snapshot: '\x1b[32m$\x1b[0m npm test\r\n\x1b[1mall 42 tests passed\x1b[0m\r\n',
        snapshotCols: 80,
        snapshotRows: 24,
        lastTitle: 'restored-agent-title'
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => [{ id: ptyId, cwd: '/tmp/restore-records' }]),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    registerPtyHandlers(mainWindow as never, runtime)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, worktreeId, tabId, leafId })

    const { terminals } = await runtime.listTerminals(`id:${worktreeId}`)
    expect(terminals).toHaveLength(1)
    const terminal = terminals[0]!
    expect(terminal.preview).toContain('$ npm test')
    expect(terminal.preview).toContain('all 42 tests passed')
    expect(terminal.title).toBe('restored-agent-title')
    // Seeded scrollback is historical — recency must come only from live bytes.
    expect(terminal.lastOutputAt).toBeNull()
    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['$ npm test', 'all 42 tests passed'])
  })

  it('seeds restore records even when the renderer pre-signals serializer ownership', async () => {
    const tabId = 'tab-gated-restore'
    const leafId = '66666666-6666-4666-8666-666666666666'
    const paneKey = makePaneKey(tabId, leafId)
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({
        id: 'pty-gated-reattach',
        isReattach: true,
        snapshot: 'gated snapshot\r\n',
        snapshotCols: 80,
        snapshotRows: 24,
        lastTitle: 'gated-title'
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
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      seedTerminalRestoreTail: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      registerPty: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'handle-gated-restore'),
      registerPreAllocatedHandleForPty: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    const gen = await handlers.get('pty:declarePendingPaneSerializer')!(null, { paneKey })

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-gated',
      tabId,
      leafId,
      env: { ORCA_PANE_KEY: paneKey }
    })

    // The renderer owns the emulator snapshot here — but the list/read records
    // are main-side only, so the record seed must still run.
    expect(runtime.seedHeadlessTerminal).not.toHaveBeenCalled()
    expect(runtime.seedTerminalRestoreTail).toHaveBeenCalledWith('pty-gated-reattach', {
      text: 'gated snapshot\r\n',
      lastTitle: 'gated-title'
    })
    await handlers.get('pty:clearPendingPaneSerializer')!(null, { paneKey, gen })
  })

  it('seeds restore records from a cold-restore payload including its checkpoint title', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({
        id: 'pty-cold-restore-records',
        coldRestore: {
          scrollback: 'cold restored history\r\n',
          cwd: '/projects/restored',
          cols: 132,
          rows: 43,
          lastTitle: 'checkpoint-title'
        }
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
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      seedTerminalRestoreTail: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'handle-cold-restore-records'),
      registerPreAllocatedHandleForPty: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    expect(runtime.seedTerminalRestoreTail).toHaveBeenCalledWith('pty-cold-restore-records', {
      text: 'cold restored history\r\n',
      lastTitle: 'checkpoint-title'
    })
  })

  // Why windowless: `orca serve`/CLI runtime creation is the topology that most
  // needs informative records — its controller.spawn path must seed them too.
  it('seeds restore records for a runtime-controller created terminal (headless reattach)', async () => {
    const worktreeId = 'repo-restore::/tmp/restore-records'
    const ptyId = `${worktreeId}@@session-headless-1`
    const session = getDefaultWorkspaceSession()
    const repo = {
      id: 'repo-restore',
      path: '/tmp/restore-records',
      displayName: 'restore',
      badgeColor: '#000000',
      addedAt: 0
    }
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => session,
      setWorkspaceSession: () => {},
      getRepo: (repoId: string) => (repoId === repo.id ? repo : undefined),
      getRepos: () => [repo],
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: () => undefined as never,
      removeWorktreeMeta: () => {},
      getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
      getProjects: () => [],
      persistPtyBinding: vi.fn()
    } as never)
    // Why: selector resolution shells out to git for real repos; prime the
    // resolved-worktree cache so this headless fixture resolves offline.
    const worktreeResolutionInternals = runtime as unknown as {
      buildResolvedWorktreeFromId(id: string): unknown
      resolvedWorktreeCache: {
        worktrees: unknown[]
        platformByRepoId: Map<string, NodeJS.Platform>
        expiresAt: number
      } | null
    }
    worktreeResolutionInternals.resolvedWorktreeCache = {
      worktrees: [worktreeResolutionInternals.buildResolvedWorktreeFromId(worktreeId)],
      platformByRepoId: new Map([[repo.id, process.platform]]),
      expiresAt: Date.now() + 60_000
    }
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({
        id: ptyId,
        isReattach: true,
        snapshot: 'headless reattach history\r\n$ ',
        snapshotCols: 80,
        snapshotRows: 24,
        lastTitle: 'headless-restored-title'
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => [{ id: ptyId, cwd: '/tmp/restore-records' }]),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    registerPtyHandlers(mainWindow as never, runtime, undefined, undefined, undefined, {
      persistPtyBinding: vi.fn()
    } as never)

    const created = await runtime.createTerminal(`id:${worktreeId}`, {
      presentation: 'background'
    })
    expect(created.ptyId).toBe(ptyId)

    const { terminals } = await runtime.listTerminals(`id:${worktreeId}`)
    const terminal = terminals.find((entry) => entry.ptyId === ptyId)
    expect(terminal).toBeDefined()
    expect(terminal!.preview).toContain('headless reattach history')
    expect(terminal!.title).toBe('headless-restored-title')
    expect(terminal!.lastOutputAt).toBeNull()
    const read = await runtime.readTerminal(created.handle)
    expect(read.tail).toContain('headless reattach history')
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

  it('retains PTY listeners until physical exit after manual kill IPC', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()
    let exitCb: ((info: { exitCode: number }) => void) | undefined
    // Why: hold a stable ref to the kill spy — destroyPtyProcess reassigns proc.kill to a no-op (docs/fix-pty-fd-leak.md), so reading proc.kill.mock later would crash.
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCb = cb
        return onExitDisposable
      }),
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

    const killPromise = handlers.get('pty:kill')!(null, { id: spawnResult.id }) as Promise<void>

    expect(killSpy).toHaveBeenCalledTimes(1)
    expect(onDataDisposable.dispose).not.toHaveBeenCalled()
    expect(onExitDisposable.dispose).not.toHaveBeenCalled()

    exitCb?.({ exitCode: -1 })
    await killPromise

    expect(onDataDisposable.dispose).toHaveBeenCalledTimes(1)
    expect(onExitDisposable.dispose).toHaveBeenCalledTimes(1)
  })

  it('retains PTY listeners until physical exit after runtime controller kill', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()
    let exitCb: ((info: { exitCode: number }) => void) | undefined
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCb = cb
        return onExitDisposable
      }),
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
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalledTimes(1))
    expect(onDataDisposable.dispose).not.toHaveBeenCalled()
    expect(onExitDisposable.dispose).not.toHaveBeenCalled()

    exitCb?.({ exitCode: -1 })
    await vi.waitFor(() => expect(onExitDisposable.dispose).toHaveBeenCalledTimes(1))
    expect(onDataDisposable.dispose).toHaveBeenCalledTimes(1)
  })

  it('retains the PTY exit listener through did-finish-load orphan cleanup', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()
    let exitCb: ((info: { exitCode: number }) => void) | undefined
    const killSpy = vi.fn()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCb = cb
        return onExitDisposable
      }),
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
    // Why both: a reload fires the gate reset AND the orphan cleanup, so invoke every registered listener like a real did-finish-load.
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

    // First load after spawn only advances generation; the second sees this PTY as from a prior load and kills it as orphaned.
    didFinishLoad()
    didFinishLoad()

    expect(onDataDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killSpy.mock.invocationCallOrder[0]
    )
    expect(onExitDisposable.dispose).not.toHaveBeenCalled()

    exitCb?.({ exitCode: -1 })
    expect(onExitDisposable.dispose).toHaveBeenCalledTimes(1)
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
    // Two listeners on the first (LocalPtyProvider) window: the renderer-gate reset and the orphan cleanup.
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
    // The non-Local provider keeps orphan cleanup off the second window — only the renderer-gate reset listener remains.
    expect(
      secondWindow.webContents.on.mock.calls.filter(
        ([eventName]) => eventName === 'did-finish-load'
      )
    ).toHaveLength(1)
  })

  // Why (#5787): a recovery reload re-fires did-finish-load; suppress the orphan sweep so live LOCAL PTYs survive until session restore re-adopts them.
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
    // Fire both did-finish-load listeners as a real reload does, else the suppression assertion passes vacuously without reaching the sweep.
    const didFinishLoadHandlers = mainWindow.webContents.on.mock.calls
      .filter(([eventName]) => eventName === 'did-finish-load')
      .map(([, handler]) => handler as () => void)
    expect(didFinishLoadHandlers.length).toBeGreaterThan(0)
    const didFinishLoad = (): void => didFinishLoadHandlers.forEach((handler) => handler())

    const spawnResult = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as {
      id: string
      incarnationId: string
    }

    // Without the guard the second load would sweep this PTY as a prior-generation orphan; under recovery-in-flight neither load may touch it.
    didFinishLoad()
    didFinishLoad()

    expect(killSpy).not.toHaveBeenCalled()
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(markClaudePtyExitedSpy).not.toHaveBeenCalled()
    const listed = await getLocalPtyProvider().listProcesses()
    expect(listed.some((info) => info.id === spawnResult.id)).toBe(true)

    markClaudePtyExitedSpy.mockRestore()
  })

  // Why: guard against over-suppression — with no recovery reload in flight the sweep MUST still reclaim genuinely orphaned local PTYs.
  it('still sweeps orphaned local PTYs when no recovery reload is in flight', async () => {
    let exitCb: ((info: { exitCode: number }) => void) | undefined
    const killSpy = vi.fn(() => {
      queueMicrotask(() => exitCb?.({ exitCode: -1 }))
    })
    const proc = {
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCb = cb
        return makeDisposable()
      }),
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
    // Fire both did-finish-load listeners (gate reset + orphan sweep) as a real reload does.
    const didFinishLoadHandlers = mainWindow.webContents.on.mock.calls
      .filter(([eventName]) => eventName === 'did-finish-load')
      .map(([, handler]) => handler as () => void)
    const didFinishLoad = (): void => didFinishLoadHandlers.forEach((handler) => handler())

    const spawnResult = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as {
      id: string
      incarnationId: string
    }

    // First load only advances generation; the second sees this PTY as a prior-load orphan — with the flag false the guard must NOT suppress the sweep.
    didFinishLoad()
    didFinishLoad()
    await Promise.resolve()

    expect(killSpy).toHaveBeenCalled()
    expect(runtime.onPtyExit).toHaveBeenCalledWith(spawnResult.id, -1, spawnResult.incarnationId)
    const listed = await getLocalPtyProvider().listProcesses()
    expect(listed.some((info) => info.id === spawnResult.id)).toBe(false)
  })

  // Why (#5787): two PTYs in different load generations must BOTH survive a recovery reload — even the older one a normal sweep would reclaim.
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
    // Fire ALL did-finish-load listeners (gate reset + orphan sweep) as a real reload does; the sweep listener is under test.
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

    // Advance the generation without sweeping (recovery-in-flight), then spawn a second PTY so the two live in different generations.
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

  it('retains PTY state when kill fails until physical exit arrives', async () => {
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

    await expect(handlers.get('pty:kill')!(null, { id: spawnResult.id })).rejects.toThrow(
      'already dead'
    )

    expect((await getLocalPtyProvider().listProcesses()).map(({ id }) => id)).toContain(
      spawnResult.id
    )
    expect(openCodeClearPtyMock).not.toHaveBeenCalled()
    expect(piClearPtyMock).not.toHaveBeenCalled()

    exitCb?.({ exitCode: -1 })

    expect((await getLocalPtyProvider().listProcesses()).map(({ id }) => id)).not.toContain(
      spawnResult.id
    )
    expect(openCodeClearPtyMock).toHaveBeenCalledWith(spawnResult.id)
    expect(piClearPtyMock).toHaveBeenCalledWith(spawnResult.id)
  })

  describe('agent_started telemetry', () => {
    // Why: telemetry-plan.md§Agent launch semantics — agent_started fires only after provider.spawn resolves; a malformed payload must not emit a silent event.
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
      // Why: agent_started fires only on confirmed launch — inject a throwing provider to hit the catch path with no race against the real LocalPtyProvider.
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
      // Why: the bug registered one listener per request, so 12 concurrent calls would trip Node's MaxListeners.
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

  describe('provider buffer snapshot dispatch', () => {
    it('exposes daemon history when no renderer pane is mounted', async () => {
      const provider = installObservableDaemonTestProvider()
      provider.getBufferSnapshot.mockResolvedValue({
        data: 'restored screen\r\n',
        scrollbackAnsi: 'restored history\r\n',
        cols: 120,
        rows: 40,
        cwd: '/projects/restored',
        seq: 900,
        source: 'headless'
      })
      const runtime = { setPtyController: vi.fn() }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
        serializeProviderBuffer(ptyId: string, opts?: { scrollbackRows?: number }): Promise<unknown>
      }

      await expect(
        controller.serializeProviderBuffer('daemon-restored', { scrollbackRows: 5000 })
      ).resolves.toEqual({
        data: 'restored screen\r\n',
        scrollbackAnsi: 'restored history\r\n',
        cols: 120,
        rows: 40,
        cwd: '/projects/restored',
        seq: 900,
        source: 'headless'
      })
      expect(provider.getBufferSnapshot).toHaveBeenCalledWith('daemon-restored', {
        scrollbackRows: 5000
      })
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
      // Why pendingDeliveryStartSeq === seq: pending delivery queue is empty, so low-seq live chunks must not be dropped against the snapshot baseline.
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
        // Bytes between main's absolute seq and the daemon snapshot may still be queued on the stream socket and must dedupe on arrival.
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

        // Starved pending entry: bytes ingested but not yet flushed to the renderer — they can still arrive after the snapshot.
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
