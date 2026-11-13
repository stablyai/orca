import type * as WslPathOwner from '../../../shared/wsl-paths'
import type * as WslAvailabilityTypes from '../../wsl/discovery/wsl-availability'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from '../shell-launch/macos/tcc-login-shell'
import type * as ForegroundProcess from '../foreground/agent-process'

const {
  fullTable,
  identityTable,
  consoleMembers,
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
  createShellPromptReadinessProbeMock
} = vi.hoisted(() => ({
  fullTable: vi.fn(),
  identityTable: vi.fn(),
  consoleMembers: vi.fn(),
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
  createShellPromptReadinessProbeMock: vi.fn()
}))

vi.mock('../../../shared/wsl-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof WslPathOwner>()),
  toLinuxPath: (path: string) => path.replace(/^C:\\/i, '/mnt/c/').replace(/\\/g, '/'),
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

// The fs mock misses executable probes; pin paths here and leave Store-alias coverage to the resolver tests.
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

vi.mock('../foreground/agent-process', async (importOriginal) => ({
  ...(await importOriginal<typeof ForegroundProcess>()),
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('../foreground/windows/pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readWindowsPtyJobProcessIdsMock(...args),
  isWindowsPtyJobReadable: () => true
}))

vi.mock('../../windows/windows-process-table', () => ({
  readWindowsProcessTable: fullTable,
  readWindowsProcessTableFresh: fullTable,
  readWindowsProcessIdentityTable: identityTable,
  readWindowsProcessIdentityTableFresh: identityTable
}))
vi.mock('../foreground/windows/console-attached-processes', () => ({
  readWindowsConsoleAttachedProcessIds: consoleMembers
}))

vi.mock('../../wsl/filesystem/unc-path-access', () => ({
  parseWslPath: (path: string) => {
    const match = path.match(/^\\\\wsl\.localhost\\([^\\]+)(.*)$/)
    if (!match) {
      return null
    }
    return {
      distro: match[1],
      linuxPath: (match[2] || '').replace(/\\/g, '/') || '/'
    }
  },
  wslUncDirectoryExistsAsync: (...args: unknown[]) => wslUncDirectoryExistsAsyncMock(...args)
}))
vi.mock('../../wsl/discovery/distro-catalog', () => ({
  getDefaultWslDistro: () => 'Ubuntu'
}))

vi.mock('../../wsl/discovery/wsl-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof WslAvailabilityTypes>()),
  isWslAvailableAsync: () => isWslAvailableAsyncMock()
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

  describe('hasChildProcesses', () => {
    it('fences full inspection with the original PTY incarnation across awaits', async () => {
      const { id, incarnationId } = await provider.spawn({ cols: 80, rows: 24 })
      await expect(
        provider.inspectProcess(id, { expectedIncarnationId: 'replacement' })
      ).resolves.toMatchObject({ childProcessEvidence: 'unverifiable' })
      let resolveScan!: (resolution: { available: boolean; processName: string }) => void
      resolveAgentForegroundProcessMock.mockReturnValue(
        new Promise((resolve) => {
          resolveScan = resolve
        })
      )
      const inspection = provider.inspectProcess(id, { expectedIncarnationId: incarnationId })
      exitCb?.({ exitCode: 0 })
      resolveScan({ available: true, processName: 'zsh' })
      await expect(inspection).resolves.toMatchObject({ childProcessEvidence: 'unverifiable' })
    })
  })

  describe('getForegroundProcess', () => {
    it('retires an anchored agent immediately when its pid leaves the job, despite a leftover', async () => {
      // A missing anchor proves exit immediately; detached leftovers cannot preserve that identity.
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({
          available: true,
          processName: 'claude',
          processId: 999
        })
        .mockResolvedValue({ available: true, processName: null })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 777]))
      await expect(provider.getForegroundProcess(id)).resolves.toBeNull()
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
    })

    it('drops an anchored agent when the drift recheck proves the pid was recycled', async () => {
      // A recycled PID still in the job cannot preserve an identity contradicted by the scan.
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({ available: true, processName: 'claude', processId: 999 })
        .mockResolvedValue({ available: true, processName: null, anchorPidForeign: true })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')

        vi.setSystemTime(1_000_000 + 40_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBeNull()
        expect(resolveAgentForegroundProcessMock).toHaveBeenLastCalledWith(
          mockProc.pid,
          'powershell.exe',
          expect.objectContaining({ anchorProcessId: 999 })
        )
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
