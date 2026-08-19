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
const CODEX_LAUNCH_PREFLIGHT = 'C:\\Program Files\\Orca\\orca.exe'
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
import { POWERLEVEL10K_WIZARD_DISABLE_ENV } from '../pty/powerlevel10k-wizard-env'

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
    it('does not pass a Windows Codex home into WSL terminals', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          env.CODEX_HOME = 'C:\\Users\\jin\\.codex'
          env.ORCA_CODEX_HOME = 'C:\\Users\\jin\\.codex'
          return env
        }
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[2].env.CODEX_HOME).toBeUndefined()
      expect(spawnCall[2].env.ORCA_CODEX_HOME).toBeUndefined()
    })

    it('does not pass a WSL managed Codex home into Windows terminals', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          env.CODEX_HOME =
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
          env.ORCA_CODEX_HOME =
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
          return env
        }
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: 'C:\\Users\\jin\\repo'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[2].env.CODEX_HOME).toBeUndefined()
      expect(spawnCall[2].env.ORCA_CODEX_HOME).toBeUndefined()
    })

    it('preserves an explicit Linux Codex home for WSL terminals', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          env.CODEX_HOME = '/home/jin/.codex-alt'
          return env
        }
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[2].env.CODEX_HOME).toBe('/home/jin/.codex-alt')
      expect(spawnCall[2].env.WSLENV).toContain('CODEX_HOME')
    })

    it('translates a WSL managed Codex home before launching a WSL terminal', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          env.CODEX_HOME =
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
          env.ORCA_CODEX_HOME =
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
          return env
        }
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[2].env.CODEX_HOME).toBe('/home/jin/.local/share/orca/codex-accounts/a/home')
      expect(spawnCall[2].env.ORCA_CODEX_HOME).toBe(
        '/home/jin/.local/share/orca/codex-accounts/a/home'
      )
      expect(spawnCall[2].env.WSLENV).toContain('CODEX_HOME')
      expect(spawnCall[2].env.WSLENV).toContain('ORCA_CODEX_HOME')
    })

    it('does not pass a WSL managed Codex home into a different WSL distro', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          env.CODEX_HOME =
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
          env.ORCA_CODEX_HOME =
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
          return env
        }
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Debian\\home\\jin\\repo'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[2].env.CODEX_HOME).toBeUndefined()
      expect(spawnCall[2].env.ORCA_CODEX_HOME).toBeUndefined()
    })

    it('uses the preferred WSL distro for Windows cwd WSL terminals', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

      await provider.spawn({
        cols: 80,
        rows: 24,
        worktreeId: 'repo-1::C:\\Users\\jin\\repo',
        cwd: 'C:\\Users\\jin\\repo',
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[1]).toEqual([
        '-d',
        'Debian',
        '--exec',
        'sh',
        '-c',
        expect.stringContaining("cd '/mnt/c/Users/jin/repo'")
      ])
      expect(spawnCall[1][5]).toContain('exec "$_orca_wsl_shell" -l')
      expect(spawnCall[2].env.HISTFILE).toContain('terminal-history-wsl/Debian')
    })

    it.each(['/home/jin/repo', '/a', '/c'])(
      'preserves a POSIX cwd through the preferred WSL distro (%s)',
      async (cwd) => {
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

        await provider.spawn({
          cols: 80,
          rows: 24,
          worktreeId: 'repo-1::C:\\Users\\jin\\repo',
          cwd,
          prevalidatedCwd: `\\\\wsl.localhost\\Debian${cwd.replaceAll('/', '\\')}`,
          shellOverride: 'wsl.exe',
          terminalWindowsWslDistro: 'Debian'
        })

        const spawnCall = spawnMock.mock.calls.at(-1)!
        expect(spawnCall[0]).toBe('wsl.exe')
        expect(spawnCall[1]).toEqual([
          '-d',
          'Debian',
          '--exec',
          'sh',
          '-c',
          expect.stringContaining(`cd '${cwd}'`)
        ])
        expect(spawnCall[2].cwd).not.toBe(cwd)
        expect(wslUncDirectoryExistsMock).not.toHaveBeenCalled()
      }
    )

    it('revalidates when cwd evidence does not exactly match the resolved WSL path', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

      await provider.spawn({
        cols: 80,
        rows: 24,
        worktreeId: 'repo-1::C:\\Users\\jin\\repo',
        cwd: '/a',
        prevalidatedCwd: '\\\\wsl.localhost\\Debian\\c',
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian'
      })

      expect(wslUncDirectoryExistsMock).toHaveBeenCalledWith('\\\\wsl.localhost\\Debian\\a')
    })

    it('resolves and persists the default distro for Windows cwd WSL terminals', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const buildSpawnEnv = vi.fn(
        (
          _id: string,
          env: Record<string, string>,
          _ctx?: { isWsl?: boolean; wslDistro?: string | null }
        ) => env
      )
      provider.configure({ buildSpawnEnv })

      const result = await provider.spawn({
        cols: 80,
        rows: 24,
        worktreeId: 'repo-1::C:\\Users\\jin\\repo',
        cwd: 'C:\\Users\\jin\\repo',
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: null
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[1]).toEqual([
        '-d',
        'Ubuntu',
        '--exec',
        'sh',
        '-c',
        expect.stringContaining("cd '/mnt/c/Users/jin/repo'")
      ])
      expect(buildSpawnEnv.mock.calls[0]?.[2]).toMatchObject({
        isWsl: true,
        wslDistro: 'Ubuntu'
      })
      expect(result.wslDistro).toBe('Ubuntu')
      expect(
        (await provider.listProcesses()).find((entry) => entry.id === result.id)?.wslDistro
      ).toBe('Ubuntu')
    })

    it('repro: keeps explicit PowerShell 7 selection when the pwsh probe is cold-false', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const pwshAvailable = vi.fn(() => false)
      provider.configure({
        getWindowsShell: () => 'powershell.exe',
        getWindowsPowerShellImplementation: () => 'pwsh.exe',
        pwshAvailable
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: 'C:\\Users\\jin\\repo'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe(PWSH7_ABS)
      expect(spawnCall[1]).toContain('-EncodedCommand')
      expect(pwshAvailable).not.toHaveBeenCalled()
    })

    it('awaits PowerShell availability before resolving an automatic Windows shell', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      let resolveAvailability!: (available: boolean) => void
      const pwshAvailable = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveAvailability = resolve
          })
      )
      provider.configure({
        getWindowsShell: () => 'powershell.exe',
        getWindowsPowerShellImplementation: () => 'auto',
        pwshAvailable
      })

      const callsBeforeSpawn = spawnMock.mock.calls.length
      const spawn = provider.spawn({ cols: 80, rows: 24, cwd: 'C:\\Users\\jin\\repo' })
      await Promise.resolve()
      expect(spawnMock).toHaveBeenCalledTimes(callsBeforeSpawn)

      resolveAvailability(true)
      await spawn
      expect(spawnMock).toHaveBeenCalledTimes(callsBeforeSpawn + 1)
      expect(spawnMock.mock.calls.at(-1)?.[0]).toBe(PWSH7_ABS)
    })

    it('marks Orca terminal handle for WSL import when buildSpawnEnv opts in', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const savedCodexHome = process.env.CODEX_HOME
      const savedOrcaCodexHome = process.env.ORCA_CODEX_HOME
      delete process.env.CODEX_HOME
      delete process.env.ORCA_CODEX_HOME
      provider.configure({
        buildSpawnEnv: (_id, env, ctx) => {
          env.ORCA_TERMINAL_HANDLE = 'term_wsl'
          if (ctx?.isWsl) {
            env.WSLENV = 'ORCA_TERMINAL_HANDLE/u'
          }
          return env
        }
      })

      try {
        await provider.spawn({
          cols: 80,
          rows: 24,
          cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
          env: { ORCA_HERMES_STARTUP_QUERY: 'line one\nline two' }
        })
      } finally {
        if (savedCodexHome === undefined) {
          delete process.env.CODEX_HOME
        } else {
          process.env.CODEX_HOME = savedCodexHome
        }
        if (savedOrcaCodexHome === undefined) {
          delete process.env.ORCA_CODEX_HOME
        } else {
          process.env.ORCA_CODEX_HOME = savedOrcaCodexHome
        }
      }

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[2].env.ORCA_TERMINAL_HANDLE).toBe('term_wsl')
      expect(spawnCall[2].env.WSLENV?.split(':')).toEqual(
        expect.arrayContaining([
          'ORCA_TERMINAL_HANDLE/u',
          'ORCA_HERMES_STARTUP_QUERY',
          POWERLEVEL10K_WIZARD_DISABLE_ENV
        ])
      )
    })

    it('does not mark deleted Powerlevel10k wizard env for WSL import', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
        envToDelete: [POWERLEVEL10K_WIZARD_DISABLE_ENV]
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[2].env[POWERLEVEL10K_WIZARD_DISABLE_ENV]).toBeUndefined()
      expect(spawnCall[2].env.WSLENV ?? '').not.toContain(POWERLEVEL10K_WIZARD_DISABLE_ENV)
    })

    it('launches POSIX cwd split panes through WSL when worktree context is WSL', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })

      try {
        await provider.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/jin/repo/subdir',
          shellOverride: 'powershell.exe',
          worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
        })
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }

      expect(spawnMock).toHaveBeenCalledWith(
        'wsl.exe',
        ['-d', 'Ubuntu', '--exec', 'sh', '-c', expect.stringContaining("cd '/home/jin/repo/subdir'")],
        expect.objectContaining({ cwd: expect.any(String) })
      )
    })

    it('resolves the Git Bash default shell and preserves the requested cwd', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      const originalProgramFiles = process.env.ProgramFiles
      Object.defineProperty(process, 'platform', { value: 'win32' })
      process.env.ProgramFiles = 'C:\\Program Files'
      provider.configure({
        getWindowsShell: () => 'git-bash',
        buildSpawnEnv: (_id, env) => ({
          ...env,
          ORCA_CODEX_LAUNCH_PREFLIGHT: CODEX_LAUNCH_PREFLIGHT
        })
      })

      try {
        await provider.spawn({
          cols: 80,
          rows: 24,
          cwd: 'C:\\Users\\jin\\repo'
        })
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
        if (originalProgramFiles === undefined) {
          delete process.env.ProgramFiles
        } else {
          process.env.ProgramFiles = originalProgramFiles
        }
      }

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        [
          '-c',
          expect.stringMatching(
            /^chcp\.com 65001 >\/dev\/null 2>&1; exec "\$BASH" --rcfile '.*shell-ready\/bash\/rcfile' -i$/
          )
        ],
        expect.objectContaining({
          cwd: 'C:\\Users\\jin\\repo',
          env: expect.objectContaining({
            CHERE_INVOKING: '1',
            PYTHONUTF8: '1',
            ORCA_CODEX_LAUNCH_PREFLIGHT: CODEX_LAUNCH_PREFLIGHT
          })
        })
      )
    })

    it('runs the Codex preflight once in the cmd.exe startup chain', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      provider.configure({
        getWindowsShell: () => 'cmd.exe',
        buildSpawnEnv: (_id, env) => ({
          ...env,
          ORCA_CODEX_LAUNCH_PREFLIGHT: CODEX_LAUNCH_PREFLIGHT
        })
      })

      try {
        await provider.spawn({ cols: 80, rows: 24, cwd: 'C:\\Users\\jin\\repo' })
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }

      expect(spawnMock).toHaveBeenCalledWith(
        'cmd.exe',
        [
          '/K',
          'chcp 65001 > nul & if defined ORCA_CODEX_LAUNCH_PREFLIGHT call %ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE%%ORCA_CODEX_LAUNCH_PREFLIGHT%%ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE% agent hooks prepare-codex > nul 2>&1'
        ],
        expect.objectContaining({
          env: expect.objectContaining({
            ORCA_CODEX_LAUNCH_PREFLIGHT: CODEX_LAUNCH_PREFLIGHT,
            ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE: '"'
          })
        })
      )
    })
  })
})
