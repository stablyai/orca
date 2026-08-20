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
  readWindowsConptyProcessIdsMock,
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
  readWindowsConptyProcessIdsMock: vi.fn(),
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

vi.mock('./windows-conpty-process-membership', () => ({
  readWindowsConptyProcessIds: (...args: unknown[]) => readWindowsConptyProcessIdsMock(...args)
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
import { isRootLikePath } from './pty-path-safety'

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
      readWindowsConptyProcessIdsMock,
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

  describe('spawn', () => {
    it('calls node-pty spawn with correct args', async () => {
      await provider.spawn({ cols: 120, rows: 40, cwd: '/tmp' })
      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          cols: 120,
          rows: 40,
          cwd: '/tmp'
        })
      )
    })

    it('throws when cwd does not exist', async () => {
      existsSyncMock.mockImplementation((p: string) => p !== '/nonexistent')
      await expect(provider.spawn({ cols: 80, rows: 24, cwd: '/nonexistent' })).rejects.toThrow(
        'does not exist'
      )
    })

    it('allows an explicitly requested plain shell at POSIX root', async () => {
      await provider.spawn({ cols: 80, rows: 24, cwd: '/' })

      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: '/' })
      )
    })

    it('falls back to the safe default cwd for automatic agent startup without an explicit cwd', async () => {
      spawnMock.mockClear()
      const origHome = process.env.HOME
      // Pin HOME so we assert the exact resolved candidate, not just non-root-ness —
      // catches regressions where resolveSafePtyDefaultCwd picks an unintended home.
      process.env.HOME = '/home/testuser'

      try {
        // Why: an omitted cwd resolves to a guaranteed-safe default home (the
        // guard only rejects root-like paths), so the agent must still launch.
        await expect(
          provider.spawn({ cols: 80, rows: 24, command: 'codex' })
        ).resolves.toBeDefined()

        const spawnCall = spawnMock.mock.calls.at(-1)!
        expect(spawnCall[2].cwd).toBe('/home/testuser')
        expect(isRootLikePath(spawnCall[2].cwd)).toBe(false)
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = origHome
        }
      }
    })

    it('rejects automatic agent startup at POSIX root', async () => {
      spawnMock.mockClear()

      await expect(
        provider.spawn({ cols: 80, rows: 24, cwd: '/', command: 'claude' })
      ).rejects.toThrow(/requires a non-root workspace/)

      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('combines HOMEDRIVE and HOMEPATH for Windows default cwd', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      const originalUserProfile = process.env.USERPROFILE
      const originalHomeDrive = process.env.HOMEDRIVE
      const originalHomePath = process.env.HOMEPATH

      Object.defineProperty(process, 'platform', { value: 'win32' })
      delete process.env.USERPROFILE
      process.env.HOMEDRIVE = 'D:'
      process.env.HOMEPATH = '\\Users\\orca'

      try {
        await provider.spawn({ cols: 80, rows: 24 })
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
        if (originalUserProfile === undefined) {
          delete process.env.USERPROFILE
        } else {
          process.env.USERPROFILE = originalUserProfile
        }
        if (originalHomeDrive === undefined) {
          delete process.env.HOMEDRIVE
        } else {
          process.env.HOMEDRIVE = originalHomeDrive
        }
        if (originalHomePath === undefined) {
          delete process.env.HOMEPATH
        } else {
          process.env.HOMEPATH = originalHomePath
        }
      }

      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: 'D:\\Users\\orca' })
      )
    })
  })
})
