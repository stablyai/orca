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
  clearPtyState,
  ptyProcesses,
  ptyWslDistroById,
  ptyWslShellAnchors
} from './local-pty-provider-state'
import { wslRelayIdentityReader } from './wsl-relay-identity-reader'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
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

  describe('listProcesses', () => {
    it('returns spawned PTYs', async () => {
      const before = await provider.listProcesses()
      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/owned-cwd',
        worktreeId: 'repo::/tmp/owned-cwd'
      })
      await provider.spawn({ cols: 80, rows: 24 })
      const after = await provider.listProcesses()
      expect(after.length - before.length).toBe(2)
      const newEntries = after.slice(before.length)
      expect(newEntries[0]).toHaveProperty('id')
      expect(newEntries[0]).toHaveProperty('title', 'zsh')
      expect(newEntries[0]).toHaveProperty('cwd', '/tmp/owned-cwd')
      expect(newEntries[0]).toHaveProperty('worktreeId', 'repo::/tmp/owned-cwd')
      expect(newEntries[0]).not.toHaveProperty('wslDistro')
      expect(newEntries[1]).not.toHaveProperty('wslDistro')
    })

    it('reports native and WSL ownership explicitly on Windows', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const native = await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo',
        shellOverride: 'powershell.exe'
      })
      const wsl = await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
      })

      const processes = await provider.listProcesses()

      expect(processes.find((process) => process.id === native.id)?.wslDistro).toBeNull()
      expect(processes.find((process) => process.id === wsl.id)?.wslDistro).toBe('Ubuntu')
    })

    it('keeps batch identity results attached when a pane exits mid-read', async () => {
      const first = await provider.spawn({ cols: 80, rows: 24 })
      const second = await provider.spawn({ cols: 80, rows: 24 })
      const anchor = (pid: number) => ({
        distro: 'Ubuntu',
        bootId: '11111111-1111-1111-1111-111111111111',
        shellPid: pid,
        shellStartTime: 1,
        tty: '/dev/pts/1'
      })
      const firstAnchor = anchor(100)
      const secondAnchor = anchor(200)
      for (const [id, shellAnchor] of [
        [first.id, firstAnchor],
        [second.id, secondAnchor]
      ] as const) {
        ptyWslDistroById.set(id, 'Ubuntu')
        ptyWslShellAnchors.set(id, shellAnchor)
      }
      const readBatch = vi
        .spyOn(wslRelayIdentityReader, 'readBatch')
        .mockImplementation(async (_distro, anchors) => {
          clearPtyState(first.id)
          return anchors.map((current, index) => ({
            status: 'live' as const,
            processName: index === 0 ? 'claude' : 'shell',
            anchor: current,
            capturedAgeMs: 0
          }))
        })
      try {
        const processes = await provider.listProcesses()
        const surviving = processes.find((process) => process.id === second.id)
        expect(processes.some((process) => process.id === first.id)).toBe(false)
        expect(surviving).toMatchObject({
          id: second.id,
          title: 'shell',
          foregroundProcessEvidence: { verdict: 'live', processName: 'shell' }
        })
        expect(ptyWslShellAnchors.get(second.id)).toEqual(secondAnchor)
        expect(ptyProcesses.has(second.id)).toBe(true)
      } finally {
        readBatch.mockRestore()
      }
    })

    it('coalesces repeated WSL list-process bursts until a PTY event resets identity', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const spawned = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/wsl-owned-cwd' })
      const anchor = {
        distro: 'Ubuntu',
        bootId: '11111111-1111-1111-1111-111111111111',
        shellPid: 100,
        shellStartTime: 1,
        tty: '/dev/pts/1'
      }
      ptyWslDistroById.set(spawned.id, 'Ubuntu')
      ptyWslShellAnchors.set(spawned.id, anchor)
      wslRelayIdentityReader.reset()
      const identityRequest = vi
        .spyOn(wslHookRelayManager, 'readProcessIdentity')
        .mockResolvedValue([
          {
            status: 'unverifiable' as const,
            reason: 'relay_unavailable',
            capturedAgeMs: 0
          }
        ])
      try {
        await Promise.all(Array.from({ length: 5 }, () => provider.listProcesses()))
        expect(identityRequest).toHaveBeenCalledOnce()

        await Promise.all(Array.from({ length: 5 }, () => provider.listProcesses()))
        expect(identityRequest).toHaveBeenCalledOnce()

        wslRelayIdentityReader.reset()
        await provider.listProcesses()
        expect(identityRequest).toHaveBeenCalledTimes(2)
      } finally {
        identityRequest.mockRestore()
        clearPtyState(spawned.id)
      }
    })
  })

  describe('getDefaultShell', () => {
    it('returns SHELL env var on Unix', async () => {
      const originalShell = process.env.SHELL
      try {
        process.env.SHELL = '/bin/bash'
        expect(await provider.getDefaultShell()).toBe('/bin/bash')
      } finally {
        if (originalShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = originalShell
        }
      }
    })
  })

  describe('getProfiles', () => {
    it('awaits asynchronous WSL availability on Windows', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      let resolveAvailability!: (available: boolean) => void
      isWslAvailableAsyncMock.mockReturnValue(
        new Promise((resolve) => {
          resolveAvailability = resolve
        })
      )

      const profiles = provider.getProfiles()
      let settled = false
      void profiles.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      resolveAvailability(true)
      await expect(profiles).resolves.toContainEqual({ name: 'WSL', path: 'wsl.exe' })
      expect(isWslAvailableAsyncMock).toHaveBeenCalledOnce()
    })
  })
})
