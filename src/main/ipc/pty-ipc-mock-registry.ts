import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type * as Wsl from '../wsl'

// Why: every split pty IPC suite must mock the same module graph; the vi.mock calls stay
// per-file (hoisting is per-file) but delegate their factories here so the vi.fn instances
// are one shared set the tests can assert on.
export const handleMock: Mock = vi.fn()
export const onMock: Mock = vi.fn()
export const removeHandlerMock: Mock = vi.fn()
export const removeAllListenersMock: Mock = vi.fn()
export const existsSyncMock: Mock = vi.fn()
export const statSyncMock: Mock = vi.fn()
export const accessSyncMock: Mock = vi.fn()
export const mkdirSyncMock: Mock = vi.fn()
export const readFileSyncMock: Mock = vi.fn()
export const writeFileSyncMock: Mock = vi.fn()
export const chmodSyncMock: Mock = vi.fn()
export const linuxCliShimMock: Mock = vi.fn()
export const renameSyncMock: Mock = vi.fn()
export const rmSyncMock: Mock = vi.fn()
export const getPathMock: Mock = vi.fn()
export const loginPreflightExecFileMock: Mock = vi.fn()
export const spawnMock: Mock = vi.fn()
export const openCodeBuildPtyEnvMock: Mock = vi.fn()
export const mimoCodeBuildPtyEnvMock: Mock = vi.fn()
export const isPwshAvailableMock: Mock = vi.fn()
export const wslUncDirectoryExistsAsyncMock: Mock = vi.fn()
export const openCodeClearPtyMock: Mock = vi.fn()
export const buildAgentHookEnvMock: Mock = vi.fn()
export const clearAgentHookPaneStateMock: Mock = vi.fn()
export const registerPaneKeyAliasMock: Mock = vi.fn()
export const piBuildPtyEnvMock: Mock = vi.fn()
export const piBuildOmpPromptReadinessEnvMock: Mock = vi.fn(() => ({}))
export const piClearPtyMock: Mock = vi.fn()
export const trackMock: Mock = vi.fn()
export const classifyErrorMock: Mock = vi.fn()
export const registerPtyMock: Mock = vi.fn()
export const unregisterPtyMock: Mock = vi.fn()
export const setMigrationUnsupportedPtyMock: Mock = vi.fn()
export const clearMigrationUnsupportedPtyMock: Mock = vi.fn()
export const clearMigrationUnsupportedPtysForPaneKeyMock: Mock = vi.fn()
export const clearPaneKeyAliasesForPtyMock: Mock = vi.fn()
export const recordCodexPaneAccountMock: Mock = vi.fn()
export const forgetCodexPaneAccountMock: Mock = vi.fn()
export const getCodexPaneAccountMock: Mock = vi.fn()
export const ensureCodexBackfillRecoveryMock: Mock<() => Promise<void>> = vi.fn(() =>
  Promise.resolve()
)

export type ElectronModuleMock = {
  BrowserWindow: undefined
  app: { isPackaged: boolean; getPath: Mock; getVersion: () => string }
  powerMonitor: { on: Mock }
  nativeTheme: { shouldUseDarkColors: boolean }
  ipcMain: { handle: Mock; on: Mock; removeHandler: Mock; removeAllListeners: Mock }
}

export const electronModuleMock = (): ElectronModuleMock => ({
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
})

export const fsModuleMock = () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: chmodSyncMock,
  renameSync: renameSyncMock,
  rmSync: rmSyncMock,
  mkdtempSync: () => '/tmp/orca-watcher-canary-test',
  constants: {
    X_OK: 1,
    R_OK: 4
  }
})

export const nodePtyModuleMock = () => ({
  spawn: spawnMock
})

// Why: these suites force darwin on non-macOS hosts; isolate the PAM probe while preserving other child_process APIs.
export const childProcessModuleMock = (original: Record<string, unknown>) => ({
  ...original,
  execFile: loginPreflightExecFileMock
})

export const openCodeHookServiceModuleMock = () => ({
  openCodeHookService: {
    buildPtyEnv: openCodeBuildPtyEnvMock,
    clearPty: openCodeClearPtyMock
  }
})

export const mimoHookServiceModuleMock = () => ({
  mimoCodeHookService: {
    buildPtyEnv: mimoCodeBuildPtyEnvMock
  }
})

export const agentHookServerModuleMock = () => ({
  agentHookServer: {
    buildPtyEnv: buildAgentHookEnvMock,
    clearPaneState: clearAgentHookPaneStateMock,
    registerPaneKeyAlias: registerPaneKeyAliasMock,
    clearPaneKeyAliasesForPty: clearPaneKeyAliasesForPtyMock
  }
})

export const piTitlebarExtensionModuleMock = () => ({
  piTitlebarExtensionService: {
    buildPtyEnv: piBuildPtyEnvMock,
    buildOmpPromptReadinessEnv: piBuildOmpPromptReadinessEnvMock,
    clearPty: piClearPtyMock
  }
})

export const pwshModuleMock = () => ({
  isPwshAvailableAsync: isPwshAvailableMock
})

export const wslModuleMock = (original: typeof Wsl) => ({
  ...original,
  wslUncDirectoryExistsAsync: (...args: unknown[]) => wslUncDirectoryExistsAsyncMock(...args)
})

export const telemetryClientModuleMock = () => ({
  track: trackMock
})

export const classifyErrorModuleMock = () => ({
  classifyError: classifyErrorMock
})

// Why: the real ensure writes to process.resourcesPath (absent under vitest); env assembly only needs the returned dir path.
export const linuxCliShimModuleMock = () => ({
  ensureLinuxTerminalOrcaCliShimDir: linuxCliShimMock
})

export const ptyRegistryModuleMock = () => ({
  registerPty: registerPtyMock,
  unregisterPty: unregisterPtyMock
})

export const migrationUnsupportedPtyModuleMock = () => ({
  setMigrationUnsupportedPty: setMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPty: clearMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPtysForPaneKey: clearMigrationUnsupportedPtysForPaneKeyMock
})

export const codexPaneAccountRegistryModuleMock = () => ({
  recordCodexPaneAccount: recordCodexPaneAccountMock,
  forgetCodexPaneAccount: forgetCodexPaneAccountMock,
  getCodexPaneAccount: getCodexPaneAccountMock
})

export const codexBackfillRecoveryModuleMock = () => ({
  ensureCodexStateDbBackfillRecoveryStarted: ensureCodexBackfillRecoveryMock
})
