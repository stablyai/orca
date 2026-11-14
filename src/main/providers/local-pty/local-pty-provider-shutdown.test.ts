import type * as WslPathOwner from '../../../shared/wsl-paths'
import type * as WslAvailabilityTypes from '../../wsl/discovery/wsl-availability'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from '../shell-launch/macos/tcc-login-shell'
import type * as PosixPtyProcessTable from '../../pty/process-retirement/posix-pty-process-table'

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
  readProcessTableMock
} = vi.hoisted(() => ({
  readProcessTableMock: vi.fn<(rootPid: number) => Promise<string>>(),
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

// Fixture pids must never be looked up in the real host process table.
vi.mock('../../pty/process-retirement/posix-pty-process-table', async (importOriginal) => ({
  ...(await importOriginal<typeof PosixPtyProcessTable>()),
  readPosixPtyProcessTable: readProcessTableMock,
  readPosixPtyProcessTableSync: () => ''
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

vi.mock('../foreground/agent-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('../foreground/windows/pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readWindowsPtyJobProcessIdsMock(...args),
  isWindowsPtyJobReadable: () => true
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
import { observeInProcessWorkerExits } from '../../ipc/pty/runtime/in-process-exit-observer'
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
    readProcessTableMock.mockReset()
    readProcessTableMock.mockResolvedValue('')

    provider = new LocalPtyProvider()
  })

  describe('shutdown', () => {
    it('keeps shutdown and ownership pending until node-pty reports physical exit', async () => {
      const killSpy = vi.fn()
      mockProc.kill = killSpy
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      let settled = false
      const shutdown = provider.shutdown(id, { immediate: true }).finally(() => {
        settled = true
      })
      await Promise.resolve()

      expect(killSpy).toHaveBeenCalledWith('SIGKILL')
      expect(settled).toBe(false)
      expect(provider.hasPty(id)).toBe(true)
      exitCb?.({ exitCode: 137 })
      await shutdown
      expect(provider.hasPty(id)).toBe(false)
    })
  })

  describe('exit proof for workers it ran', () => {
    it('reports its exact physical exit once, to the observer installed last', async () => {
      const replaced = { recordInProcessPtyExit: vi.fn() }
      const current = { recordInProcessPtyExit: vi.fn() }
      observeInProcessWorkerExits(replaced)
      observeInProcessWorkerExits(current)
      try {
        const { id } = await provider.spawn({ cols: 80, rows: 24 })
        const [live] = await provider.listProcesses()
        expect(live).toMatchObject({ id, incarnationId: expect.any(String) })

        exitCb?.({ exitCode: 0 })
        await vi.waitFor(() => expect(current.recordInProcessPtyExit).toHaveBeenCalledTimes(1))

        expect(current.recordInProcessPtyExit).toHaveBeenCalledWith(`${id}:${live!.incarnationId}`)
        expect(replaced.recordInProcessPtyExit).not.toHaveBeenCalled()
        await expect(provider.listProcesses()).resolves.toEqual([])
      } finally {
        observeInProcessWorkerExits(undefined)
      }
    })
  })
})
