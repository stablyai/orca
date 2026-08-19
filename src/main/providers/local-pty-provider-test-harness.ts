import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { _resetLocalPtyProviderStateForTest } from './local-pty-provider'

export type LocalPtyExitCallback = (info: { exitCode: number }) => void

export type LocalPtyMockProcess = {
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  process: string
  pid: number
}

export type LocalPtyProviderMocks = {
  existsSyncMock: Mock
  statSyncMock: Mock
  accessSyncMock: Mock
  mkdirSyncMock: Mock
  writeFileSyncMock: Mock
  prepareMacosTccLoginShellMock: Mock
  resolveAgentForegroundProcessMock: Mock
  readWindowsConptyProcessIdsMock: Mock
  killWithDescendantSweepMock: Mock
  isWslAvailableAsyncMock: Mock
  wslUncDirectoryExistsMock: Mock
  createShellPromptReadinessProbeMock: Mock
}

/** Pins platform/shell env for every test and restores it plus provider module state after. */
export function installLocalPtyProviderEnvSandbox(): void {
  let origShell: string | undefined
  let origPowerlevelWizardDisable: string | undefined
  let origHistFile: string | undefined
  let origPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    origShell = process.env.SHELL
    origPowerlevelWizardDisable = process.env.POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD
    origHistFile = process.env.HISTFILE
    process.env.SHELL = '/bin/zsh'
    delete process.env.POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD
    // injectHistoryEnv preserves an inherited HISTFILE, so clear it for hermetic history assertions.
    delete process.env.HISTFILE
  })

  afterEach(() => {
    _resetLocalPtyProviderStateForTest()
    if (origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform)
    }
    if (origShell === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = origShell
    }
    if (origPowerlevelWizardDisable === undefined) {
      delete process.env.POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD
    } else {
      process.env.POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD = origPowerlevelWizardDisable
    }
    if (origHistFile === undefined) {
      delete process.env.HISTFILE
    } else {
      process.env.HISTFILE = origHistFile
    }
  })
}

export function applyLocalPtyProviderMockDefaults(mocks: LocalPtyProviderMocks): void {
  mocks.existsSyncMock.mockReturnValue(true)
  // size: the wrapper writer verifies each generated file is non-empty.
  mocks.statSyncMock.mockReturnValue({ isDirectory: () => true, mode: 0o755, size: 1 })
  mocks.accessSyncMock.mockReturnValue(undefined)
  mocks.mkdirSyncMock.mockReset()
  mocks.writeFileSyncMock.mockReset()
  mocks.killWithDescendantSweepMock.mockReset()
  // Default: no-op sweep that still runs killRoot (matches empty-snapshot degrade).
  mocks.killWithDescendantSweepMock.mockImplementation(
    async (_rootPid: number, killRoot: () => void, _deps?: { ownsRoot?: () => boolean }) => {
      killRoot()
    }
  )
  mocks.prepareMacosTccLoginShellMock.mockReset()
  mocks.prepareMacosTccLoginShellMock.mockResolvedValue(undefined)
  mocks.resolveAgentForegroundProcessMock.mockReset()
  mocks.resolveAgentForegroundProcessMock.mockImplementation(
    async (_pid: number, fallbackProcess: string | null) => ({
      available: true,
      processName: fallbackProcess
    })
  )
  mocks.readWindowsConptyProcessIdsMock.mockReset()
  mocks.readWindowsConptyProcessIdsMock.mockResolvedValue(null)
  mocks.isWslAvailableAsyncMock.mockReset()
  mocks.isWslAvailableAsyncMock.mockResolvedValue(true)
  mocks.wslUncDirectoryExistsMock.mockReset()
  mocks.wslUncDirectoryExistsMock.mockReturnValue(true)
  mocks.createShellPromptReadinessProbeMock.mockReset()
}

/** node-pty stand-in; the exit callback lives in the test file so bodies can fire it directly. */
export function createLocalPtyMockProcess(exitCallback: {
  get: () => LocalPtyExitCallback | undefined
  set: (cb: LocalPtyExitCallback | undefined) => void
}): LocalPtyMockProcess {
  return {
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((cb: LocalPtyExitCallback) => {
      exitCallback.set(cb)
      return {
        dispose: () => {
          if (exitCallback.get() === cb) {
            exitCallback.set(undefined)
          }
        }
      }
    }),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(() => {
      exitCallback.get()?.({ exitCode: -1 })
    }),
    process: 'zsh',
    pid: 12345
  }
}
