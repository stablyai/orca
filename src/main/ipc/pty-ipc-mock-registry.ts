import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type * as Wsl from '../wsl'
import type * as FsPromises from 'node:fs/promises'

// vi.mock hoists per file; shared factories keep every split suite on the same spy instances.
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
export const openCode2BuildPtyEnvMock: Mock = vi.fn()
export const mimoCodeBuildPtyEnvMock: Mock = vi.fn()
export const isPwshAvailableMock: Mock = vi.fn()
export const wslUncDirectoryExistsAsyncMock: Mock = vi.fn()
export const openCodeClearPtyMock: Mock = vi.fn()
export const buildAgentHookEnvMock: Mock = vi.fn()
export const clearAgentHookPaneStateMock: Mock = vi.fn()
export const registerPaneKeyAliasMock: Mock = vi.fn()
export const forgetRefusedPaneResumeMock: Mock = vi.fn()
export const piBuildPtyEnvMock: Mock = vi.fn()
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
  // Vitest throws for omitted exports even when production uses optional chaining.
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

// Suites force darwin on other hosts; isolate PAM probing while retaining other process APIs.
export const childProcessModuleMock = (original: Record<string, unknown>) => ({
  ...original,
  execFile: loginPreflightExecFileMock
})

export const openCodeHookServiceModuleMock = () => ({
  OpenCodeHookService: class {
    buildPtyEnv = vi.fn(() => ({}))
  },
  openCodeHookService: {
    buildPtyEnv: openCodeBuildPtyEnvMock,
    refreshLegacySharedPlugin: vi.fn<() => void>(),
    clearPty: openCodeClearPtyMock
  },
  // Independent variant spies expose accidental v1 plugin injection into OpenCode 2 panes.
  openCode2HookService: {
    buildPtyEnv: openCode2BuildPtyEnvMock,
    refreshLegacySharedPlugin: vi.fn<() => void>(),
    clearPty: openCodeClearPtyMock
  }
})

export const mimoHookServiceModuleMock = (): {
  mimoCodeHookService: { buildPtyEnv: Mock }
} => ({
  mimoCodeHookService: {
    buildPtyEnv: mimoCodeBuildPtyEnvMock
  }
})

/** What a spawn's resume admission reads from a fake runtime: no chats, so every resume runs. */
export const noChatsRuntimeMembers = () => ({
  openAgentSessionRecordStore: vi.fn(async () => ({
    listRecords: () => [],
    getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] })
  }))
})

export const agentHookServerModuleMock = () => ({
  agentHookServer: {
    buildPtyEnv: buildAgentHookEnvMock,
    clearPaneState: clearAgentHookPaneStateMock,
    registerPaneKeyAlias: registerPaneKeyAliasMock,
    forgetRefusedPaneResume: forgetRefusedPaneResumeMock,
    recordLaunchResumeIdentity: () => {},
    clearPaneKeyAliasesForPty: clearPaneKeyAliasesForPtyMock
  }
})

export const piTitlebarExtensionModuleMock = () => ({
  piTitlebarExtensionService: {
    buildPtyEnv: piBuildPtyEnvMock,
    buildFreshOmpEnv: () => ({ ORCA_OMP_FRESH_CONFIG: '/tmp/orca-fresh-session.yml' }),
    clearPty: piClearPtyMock
  }
})

export const pwshModuleMock = () => ({
  isPwshAvailableAsync: isPwshAvailableMock
})

// Async stats must observe the same fake filesystem as sync stats.
export const fsPromisesModuleMock = (original: typeof FsPromises) => ({
  ...original,
  stat: async (path: string) => {
    if (!existsSyncMock(path)) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    }
    return statSyncMock(path)
  }
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

// Avoid writes to resourcesPath; environment assembly needs only the returned shim directory.
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
