// Shared node-pty stub, PowerShell path stubs and daemon env lifecycle for the
// pty-subprocess test files. `vi.mock` calls must stay in each test file.
import { afterEach, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORCA_SHELL_WRAPPER_ENV = [
  'ORCA_OPENCODE_CONFIG_DIR',
  'ORCA_MIMOCODE_HOME',
  'ORCA_PI_CODING_AGENT_DIR',
  'ORCA_OMP_CODING_AGENT_DIR',
  'ORCA_OMP_STATUS_EXTENSION',
  'ORCA_CODEX_HOME',
  'ORCA_AGENT_TEAMS_SHIM_DIR',
  'ORCA_REMOTE_CLI_BIN_DIR'
] as const
export const POWERLEVEL10K_WIZARD_DISABLE_ENV = 'POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD'

/**
 * Makes the daemon look like it is sitting in a deleted cwd, without moving the
 * test process there.
 *
 * Why: `process.cwd()` and `process.chdir()` are process-global. The previous
 * version of these tests really did chdir into a temp dir and delete it, so every
 * other test file sharing the worker saw a missing cwd for that window — an
 * intermittent failure that got likelier once this suite was split across files.
 * Stubbing keeps the cwd-repair assertion exact and the process untouched.
 */
export function stubMissingDaemonCwd(): {
  chdirSpy: Mock<(directory: string) => void>
  restoreCwdStubs: () => void
} {
  const missingDaemonCwd = join(tmpdir(), 'orca-daemon-cwd-that-does-not-exist')
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(missingDaemonCwd)
  const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {})
  return {
    chdirSpy: chdirSpy as unknown as Mock<(directory: string) => void>,
    restoreCwdStubs: () => {
      cwdSpy.mockRestore()
      chdirSpy.mockRestore()
    }
  }
}

/** Annotated so declaration emit never has to name @vitest/spy internals. */
export type MockPtyProcess = {
  pid: number
  write: Mock<(data: string) => void>
  resize: Mock<(columns: number, rows: number) => void>
  kill: Mock<(signal?: string) => void>
  process: string
  onData: Mock<(cb: (data: string) => void) => { dispose: Mock<() => void> }>
  onExit: Mock<(cb: (e: { exitCode: number }) => void) => { dispose: Mock<() => void> }>
  _simulateData: (data: string) => void
  _simulateExit: (code: number) => void
}

export function mockPtyProcess(pid = 12345): MockPtyProcess {
  const onDataListeners: ((data: string) => void)[] = []
  const onExitListeners: ((e: { exitCode: number }) => void)[] = []
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: 'zsh',
    onData: vi.fn((cb: (data: string) => void) => {
      onDataListeners.push(cb)
      return { dispose: vi.fn() }
    }),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      onExitListeners.push(cb)
      return { dispose: vi.fn() }
    }),
    _simulateData: (data: string) => onDataListeners.forEach((cb) => cb(data)),
    _simulateExit: (code: number) => onExitListeners.forEach((cb) => cb({ exitCode: code }))
  }
}

export type PtySubprocessSpawnMocks = {
  spawnMock: Mock
  isPwshAvailableMock: Mock
  resolveUnixShellPathMock: Mock
  resolveAgentForegroundProcessMock: Mock
  validateWorkingDirectoryMock: Mock
}

/** Registers the createPtySubprocess beforeEach/afterEach; `userDataPath` is set per test. */
export function useDaemonPtySubprocessEnv(mocks: PtySubprocessSpawnMocks): {
  userDataPath: string
} {
  const savedWrapperEnv: Partial<Record<(typeof ORCA_SHELL_WRAPPER_ENV)[number], string>> = {}
  const state = { userDataPath: '' }
  let previousUserDataPath: string | undefined
  let previousPowerlevelWizardDisable: string | undefined

  beforeEach(() => {
    mocks.spawnMock.mockReset()
    mocks.isPwshAvailableMock.mockReset()
    mocks.resolveAgentForegroundProcessMock.mockReset()
    mocks.resolveAgentForegroundProcessMock.mockImplementation(
      async (_pid: number, fallbackProcess: string | null) => fallbackProcess
    )
    mocks.validateWorkingDirectoryMock.mockClear()
    mocks.resolveUnixShellPathMock.mockReset()
    mocks.resolveUnixShellPathMock.mockImplementation((shellPath: string) => shellPath)
    mocks.isPwshAvailableMock.mockReturnValue(false)
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    previousPowerlevelWizardDisable = process.env[POWERLEVEL10K_WIZARD_DISABLE_ENV]
    state.userDataPath = mkdtempSync(join(tmpdir(), 'daemon-pty-subprocess-test-'))
    process.env.ORCA_USER_DATA_PATH = state.userDataPath
    delete process.env[POWERLEVEL10K_WIZARD_DISABLE_ENV]
    for (const key of ORCA_SHELL_WRAPPER_ENV) {
      savedWrapperEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    if (previousPowerlevelWizardDisable === undefined) {
      delete process.env[POWERLEVEL10K_WIZARD_DISABLE_ENV]
    } else {
      process.env[POWERLEVEL10K_WIZARD_DISABLE_ENV] = previousPowerlevelWizardDisable
    }
    rmSync(state.userDataPath, { recursive: true, force: true })
    for (const key of ORCA_SHELL_WRAPPER_ENV) {
      if (savedWrapperEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedWrapperEnv[key]
      }
      delete savedWrapperEnv[key]
    }
  })

  return state
}
