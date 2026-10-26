import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from './macos-tcc-login-shell'

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
  createShellPromptReadinessProbeMock
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
  createShellPromptReadinessProbeMock: vi.fn()
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

vi.mock('./macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// The fs mock misses executable probes; pin paths here and leave Store-alias coverage to the resolver tests.
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('./windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('./windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readWindowsPtyJobProcessIdsMock(...args),
  isWindowsPtyJobReadable: () => true
}))

vi.mock('../wsl', () => ({
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
  toLinuxPath: (path: string) => path.replace(/^C:\\/i, '/mnt/c/').replace(/\\/g, '/'),
  toWindowsWslPath: (path: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`,
  getDefaultWslDistro: () => 'Ubuntu',
  isWslAvailableAsync: () => isWslAvailableAsyncMock(),
  // Fixture WSL UNC directories exist; avoid launching wsl.exe to validate them.
  wslUncDirectoryExistsAsync: (...args: unknown[]) => wslUncDirectoryExistsAsyncMock(...args)
}))

vi.mock('../shell-prompt-readiness-probe', () => ({
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

    it('returns false when foreground process matches shell', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(await provider.hasChildProcesses(id)).toBe(false)
    })

    it('returns true when foreground process differs from shell', async () => {
      mockProc.process = 'node'
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(await provider.hasChildProcesses(id)).toBe(true)
    })

    it('returns false for unknown PTY ids', async () => {
      expect(await provider.hasChildProcesses('nonexistent')).toBe(false)
    })
  })

  describe('getForegroundProcess', () => {
    it('returns the process name', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(await provider.getForegroundProcess(id)).toBe('zsh')
    })

    it('uses the spawned Windows shell when node-pty reports only the terminal name', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'xterm-256color'

      const { id } = await provider.spawn({
        cols: 80,
        rows: 24,
        shellOverride: 'powershell.exe'
      })

      expect(await provider.getForegroundProcess(id)).toBe('powershell.exe')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledWith(
        mockProc.pid,
        'powershell.exe',
        expect.any(Object)
      )
    })

    it('returns null for unknown PTY ids', async () => {
      expect(await provider.getForegroundProcess('nonexistent')).toBeNull()
    })

    it('keeps a recognized agent across an unavailable scan without adding probes', async () => {
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({ available: true, processName: 'claude' })
        .mockResolvedValueOnce({ available: false, processName: 'powershell.exe' })
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
    })

    it('drops a delayed scan result after the PTY exits', async () => {
      let resolveScan!: (resolution: { available: boolean; processName: string }) => void
      resolveAgentForegroundProcessMock.mockReturnValue(
        new Promise((resolve) => {
          resolveScan = resolve
        })
      )
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      const foreground = provider.getForegroundProcess(id)
      exitCb?.({ exitCode: 0 })
      resolveScan({ available: true, processName: 'droid' })

      await expect(foreground).resolves.toBeNull()
    })

    it('confirms a still-active agent from job membership without a whole-table scan', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock.mockResolvedValue({
        available: true,
        processName: 'claude'
      })
      // A descendant beyond the shell is still in the pane's job.
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      // node-pty names only the shell; job membership revalidates the agent without another full scan.
      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(1)
    })

    it('stops trusting job membership once the cached agent goes stale', async () => {
      // An unanchored job superset must age out; WSL detached plumbing can otherwise pin agent identity forever.
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock.mockResolvedValue({
        available: true,
        processName: 'claude'
      })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(1)

        vi.setSystemTime(1_000_000 + 40_000)
        resolveAgentForegroundProcessMock.mockResolvedValue({
          available: true,
          processName: 'powershell.exe'
        })
        await expect(provider.getForegroundProcess(id)).resolves.toBe('powershell.exe')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not refresh the agent age after a degraded revalidation scan', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({ available: true, processName: 'claude' })
        .mockResolvedValueOnce({ available: false, processName: null })
        .mockResolvedValue({ available: true, processName: 'powershell.exe' })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')

        vi.setSystemTime(1_000_000 + 40_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')

        vi.setSystemTime(1_000_000 + 41_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('powershell.exe')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps short-circuiting a live agent instead of scanning on every call', async () => {
      // Confirmation must reset age; measuring total runtime would permanently disable cheap rechecks (#9258).
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock.mockResolvedValue({
        available: true,
        processName: 'claude'
      })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(1)

        vi.setSystemTime(1_000_000 + 40_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)

        vi.setSystemTime(1_000_000 + 45_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('falls through to the scan when the job holds only the shell', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock.mockResolvedValue({
        available: true,
        processName: 'claude'
      })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345]))
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
    })

    it('keeps the cached agent when both the console probe and process snapshot are inconclusive', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({ available: true, processName: 'claude' })
        .mockResolvedValue({ available: true, processName: null })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(null)
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
    })

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

    it('never expires an anchored agent the job still holds, even when scans miss it', async () => {
      // A live job anchor outranks incomplete scans and refreshes the age bound.
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
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')

        vi.setSystemTime(1_000_000 + 40_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)

        vi.setSystemTime(1_000_000 + 45_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)

        vi.setSystemTime(1_000_000 + 80_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('holds a restarting agent across a degraded scan instead of reporting an exit', async () => {
      // A degraded scan during restart cannot prove exit; retain unanchored identity until a fresh scan re-anchors.
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({ available: true, processName: 'claude', processId: 999 })
        .mockResolvedValueOnce({ available: false, processName: null })
        .mockResolvedValue({ available: true, processName: 'claude', processId: 1000 })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 1000]))
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        vi.setSystemTime(1_000_000 + 40_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(3)
        vi.setSystemTime(1_000_000 + 45_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
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

    it('retires the cached agent after verified shell-only membership and a no-agent scan', async () => {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({ available: true, processName: 'claude' })
        .mockResolvedValue({ available: true, processName: null })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345]))
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      await expect(provider.getForegroundProcess(id)).resolves.toBeNull()
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('confirmForegroundProcess', () => {
    it('drops a delayed result after the PTY exits', async () => {
      let resolveScan!: (resolution: { available: boolean; processName: string }) => void
      resolveAgentForegroundProcessMock.mockReturnValue(
        new Promise((resolve) => {
          resolveScan = resolve
        })
      )
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      const confirmation = provider.confirmForegroundProcess(id)
      exitCb?.({ exitCode: 0 })
      resolveScan({ available: true, processName: 'droid' })

      await expect(confirmation).resolves.toBeNull()
    })
  })
})
