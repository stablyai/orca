import { afterEach, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import {
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
  mimoCodeBuildPtyEnvMock,
  openCodeClearPtyMock,
  buildAgentHookEnvMock,
  clearAgentHookPaneStateMock,
  registerPaneKeyAliasMock,
  piBuildPtyEnvMock,
  piClearPtyMock,
  isPwshAvailableMock,
  wslUncDirectoryExistsAsyncMock,
  trackMock,
  classifyErrorMock,
  registerPtyMock,
  unregisterPtyMock,
  setMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPtysForPaneKeyMock,
  clearPaneKeyAliasesForPtyMock,
  recordCodexPaneAccountMock,
  forgetCodexPaneAccountMock,
  getCodexPaneAccountMock,
  ensureCodexBackfillRecoveryMock
} from './pty-ipc-mock-registry'
import { makeDisposable } from './pty-ipc-test-constants'
import { createPtyIpcProcessEnvScope } from './pty-ipc-process-env-scope'
import {
  LocalPtyProvider,
  _resetLocalPtyProviderStateForTest
} from '../providers/local-pty-provider'
import { setLocalPtyProvider, unregisterSshPtyProvider } from './pty'
import { _resetHiddenRendererPtyDeliveryGateForTest } from './pty-hidden-delivery-gate'
import { __resetShellStartupEnvCache } from '../pty/shell-startup-env'
import { _resetWslCachesForTests } from '../wsl'

/** The mocked webContents each suite asserts sends against. */
export type PtyIpcTestWebContents = { on: Mock; send: Mock; removeListener: Mock }

/** The mocked BrowserWindow handed to registerPtyHandlers. */
export type PtyIpcTestMainWindow = {
  isDestroyed: () => boolean
  isFocused: () => boolean
  isVisible: () => boolean
  isMinimized: () => boolean
  webContents: PtyIpcTestWebContents
}

export type PtyIpcSuiteEnvironment = {
  handlers: Map<string, (event: unknown, args: unknown) => unknown>
  mainWindow: PtyIpcTestMainWindow
  mainWindowIpcEvent: { sender: PtyIpcTestWebContents }
  foreignWindowIpcEvent: { sender: PtyIpcTestWebContents }
}

/** Registers the shared beforeEach/afterEach every pty IPC suite file relies on. */
export function createPtyIpcSuiteEnvironment(): PtyIpcSuiteEnvironment {
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
  const envScope = createPtyIpcProcessEnvScope()

  beforeEach(() => {
    envScope.applyTestEnvDefaults()
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
    wslUncDirectoryExistsAsyncMock.mockReset()
    wslUncDirectoryExistsAsyncMock.mockResolvedValue(null)
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
    getCodexPaneAccountMock.mockReset()
    ensureCodexBackfillRecoveryMock.mockReset()
    ensureCodexBackfillRecoveryMock.mockResolvedValue(undefined)
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
    // size: the shell wrapper writer verifies each generated file is non-empty.
    statSyncMock.mockReturnValue({ isDirectory: () => true, mode: 0o755, size: 1 })
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
        if (kind === 'prime-agent') {
          if (!existingAgentDir && !materializeDefaultHome) {
            return {}
          }
          return {
            ORCA_PRIME_AGENT_SOURCE_AGENT_DIR: existingAgentDir ?? '/tmp/default-prime-agent'
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
    envScope.restoreProcessEnv()
  })

  return { handlers, mainWindow, mainWindowIpcEvent, foreignWindowIpcEvent }
}
