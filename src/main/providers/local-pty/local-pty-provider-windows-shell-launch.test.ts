import type * as WslPathOwner from '../../../shared/wsl-paths'
import type * as WslAvailabilityTypes from '../../wsl/discovery/wsl-availability'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from '../shell-launch/macos/tcc-login-shell'

const { toLinuxPathMock } = vi.hoisted(() => ({
  toLinuxPathMock: (path: string) => path.replace(/^C:\\/i, '/mnt/c/').replace(/\\/g, '/')
}))

const {
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  spawnMock,
  prepareMacosTccLoginShellMock,
  resolveAgentForegroundProcessMock,
  readWindowsPtyJobProcessIdsMock,
  killWithDescendantSweepMock,
  isWslAvailableAsyncMock,
  wslUncDirectoryExistsAsyncMock,
  createShellPromptReadinessProbeMock,
  readWslDistroRunningStateMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  prepareMacosTccLoginShellMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn(),
  readWindowsPtyJobProcessIdsMock: vi.fn(),
  killWithDescendantSweepMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  wslUncDirectoryExistsAsyncMock: vi.fn(),
  createShellPromptReadinessProbeMock: vi.fn(),
  readWslDistroRunningStateMock: vi.fn()
}))

vi.mock('../../../shared/wsl-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof WslPathOwner>()),
  toLinuxPath: toLinuxPathMock,
  toWindowsWslPath: (path: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/orca-user-data')
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('../shell-launch/macos/tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../../pty/process-retirement/pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// The fs mock misses executable probes; pin paths and leave Store-alias coverage to resolver tests.
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('../shell-launch/windows/powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('../foreground/agent-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('../foreground/windows/pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readWindowsPtyJobProcessIdsMock(...args),
  isWindowsPtyJobReadable: () => true
}))

vi.mock('../../wsl/filesystem/unc-path-access', async () => ({
  parseWslPath: (await import('../../../shared/wsl-paths')).parseWslUncPath,
  wslUncDirectoryExistsAsync: (...args: unknown[]) => wslUncDirectoryExistsAsyncMock(...args)
}))
vi.mock('../../wsl/discovery/distro-catalog', async () => ({
  getDefaultWslDistro: () => 'Ubuntu'
}))

vi.mock('../../wsl/discovery/wsl-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof WslAvailabilityTypes>()),
  isWslAvailableAsync: () => isWslAvailableAsyncMock()
}))

vi.mock('../../wsl/discovery/wsl-background-distro-gate', () => ({
  readWslDistroRunningState: (...args: unknown[]) => readWslDistroRunningStateMock(...args)
}))

vi.mock('../../pty/shell-startup/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: createShellPromptReadinessProbeMock
}))

import { LocalPtyProvider } from './local-pty-provider'
import {
  applyLocalPtyProviderMockDefaults,
  createLocalPtyMockProcess,
  installLocalPtyProviderEnvSandbox,
  type LocalPtyMockProcess
} from './local-pty-provider-test-harness'

describe('LocalPtyProvider', () => {
  let provider: LocalPtyProvider
  let mockProc: LocalPtyMockProcess
  let exitCb: ((info: { exitCode: number }) => void) | undefined

  installLocalPtyProviderEnvSandbox()

  beforeEach(() => {
    applyLocalPtyProviderMockDefaults({
      existsSyncMock,
      statSyncMock,
      accessSyncMock,
      mkdirSyncMock,
      writeFileSyncMock,
      prepareMacosTccLoginShellMock,
      resolveAgentForegroundProcessMock,
      readWindowsPtyJobProcessIdsMock,
      killWithDescendantSweepMock,
      isWslAvailableAsyncMock,
      wslUncDirectoryExistsAsyncMock,
      createShellPromptReadinessProbeMock
    })

    exitCb = undefined
    mockProc = createLocalPtyMockProcess({
      get: () => exitCb,
      set: (cb) => {
        exitCb = cb
      }
    })
    spawnMock.mockReturnValue(mockProc)

    provider = new LocalPtyProvider()
  })

  describe('spawn', () => {
    it('rejects a canceled spawn while its WSL cwd probe is still pending', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const probeStarted = Promise.withResolvers<void>()
      wslUncDirectoryExistsAsyncMock.mockImplementation(() => {
        probeStarted.resolve()
        return new Promise(() => {})
      })
      const spawnCallsBefore = spawnMock.mock.calls.length

      const spawn = provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Stalled\\home\\jin\\repo',
        sessionId: 'stalled-wsl-cwd-session'
      })
      const canceledSpawn = expect(spawn).rejects.toThrow(
        'PTY spawn canceled: stalled-wsl-cwd-session'
      )
      await probeStarted.promise
      await provider.shutdown('stalled-wsl-cwd-session', { immediate: true })

      await canceledSpawn
      expect(spawnMock.mock.calls).toHaveLength(spawnCallsBefore)
    })
  })
})
