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
  wslUncDirectoryExistsMock,
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
  wslUncDirectoryExistsMock: vi.fn(),
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

// Resolve PowerShell family names to deterministic absolute paths (the fs mock
// above otherwise makes every probe miss). The real resolver — which skips the
// Store App Execution Alias stub — is covered in
// windows-powershell-executable.test.ts.
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
  // Why: WSL worktree validation now asks the distro; these tests use WSL UNC
  // cwds that are meant to exist, so report them present without spawning wsl.exe.
  wslUncDirectoryExists: (...args: unknown[]) => wslUncDirectoryExistsMock(...args)
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
      wslUncDirectoryExistsMock,
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

      // First call establishes the agent identity via the scan.
      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      // node-pty still only names the shell, but console presence confirms the
      // agent — no second whole-table scan.
      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(1)
    })

    it('stops trusting job membership once the cached agent goes stale', async () => {
      // The daemon path is not the only one that short-circuited on `size > 1`.
      // Here the early return skips the scan that is the ONLY thing able to
      // clear ptyLastRecognizedForeground, so on a WSL pane -- whose job always
      // holds console-detached plumbing -- the identity was pinned for good.
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

        // Past the bound, the superset answer stops standing in for a scan.
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
      // The age bound must mean "time since we last confirmed the agent", not
      // "how long the agent has run". Stamping only on a CHANGE of name makes a
      // steadily-recognized agent age out permanently: the short-circuit dies
      // after 30s, every call runs the whole-table scan, and one available-but-
      // agentless snapshot then deletes a LIVE agent -- the false "agent done"
      // #9258 exists to prevent.
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

        // Past the bound: one revalidating scan is expected, and it re-confirms.
        vi.setSystemTime(1_000_000 + 40_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)

        // That confirmation must restart the clock, so the short-circuit resumes.
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
      // Fix for stale-identity-behind-a-leftover: with an anchor pid, a detached
      // descendant surviving in the job no longer stands in for the dead agent
      // until the age bound -- the missing anchor is proof of exit right now.
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
      // Agent 999 exits; a detached leftover 777 keeps the job larger than the shell.
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 777]))
      await expect(provider.getForegroundProcess(id)).resolves.toBeNull()
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
    })

    it('never expires an anchored agent the job still holds, even when scans miss it', async () => {
      // Fix for false removal of a live agent: the anchor pid in the job is
      // proof of life, so >30s of agentless-but-successful scans no longer
      // retire a working agent -- and the confirmation restamps the clock.
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

        // Past the bound: one drift-recheck scan runs, finds nothing, and the
        // live anchor outranks the incomplete snapshot.
        vi.setSystemTime(1_000_000 + 40_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)

        // The proof of life restamped the clock, so the short-circuit resumes.
        vi.setSystemTime(1_000_000 + 45_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)

        // Much later again: recheck, still alive, still claude.
        vi.setSystemTime(1_000_000 + 80_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('holds a restarting agent across a degraded scan instead of reporting an exit', async () => {
      // The anchor pid died but another job member remains -- possibly the
      // agent's restarted successor under a new pid. A degraded scan at that
      // instant must not fire a false "agent done"; the next available scan
      // re-recognizes and re-anchors.
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
        // Restart: 999 exits, successor 1000 joins the job; scan degrades.
        readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 1000]))
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        // Downgraded evidence ages out; the recheck scan re-anchors the successor.
        vi.setSystemTime(1_000_000 + 40_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(3)
        // Re-anchored on pid 1000: the short-circuit resumes.
        vi.setSystemTime(1_000_000 + 45_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('drops an anchored agent when the drift recheck proves the pid was recycled', async () => {
      // The anchor pid stays in the job (a squatter reused it) but the scan
      // proves the pid now runs a non-agent: proof of life must not apply.
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
        // The recheck scan received the anchor to test against.
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
