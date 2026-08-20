// WSL routing: distro selection, cwd translation and env import marking.
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as LocalPtyUtils from '../providers/local-pty-utils'

const {
  spawnMock,
  isPwshAvailableMock,
  validateWorkingDirectoryMock,
  resolveUnixShellPathMock,
  resolveAgentForegroundProcessMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  isPwshAvailableMock: vi.fn(),
  resolveUnixShellPathMock: vi.fn((shellPath: string) => shellPath),
  resolveAgentForegroundProcessMock: vi.fn(),
  validateWorkingDirectoryMock: vi.fn((cwd: string) => {
    if (cwd.includes('definitely-missing')) {
      throw new Error(
        `Working directory "${cwd}" does not exist. It may have been deleted or is on an unmounted volume.`
      )
    }
  })
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('../pwsh', () => ({
  isPwshAvailable: isPwshAvailableMock
}))

// Resolve PowerShell family names to deterministic absolute paths so these
// tests run on non-Windows CI. The real resolver (which skips the Store App
// Execution Alias stub) is exercised in windows-powershell-executable.test.ts.
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('../providers/windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('../providers/local-pty-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalPtyUtils>()
  return {
    ...actual,
    resolveUnixShellPath: resolveUnixShellPathMock,
    validateWorkingDirectory: validateWorkingDirectoryMock,
    validateWorkingDirectoryAsync: validateWorkingDirectoryMock
  }
})

vi.mock('../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: async (...args: unknown[]) => {
    const value = await resolveAgentForegroundProcessMock(...args)
    return value && typeof value === 'object' && 'available' in value
      ? value
      : { available: true, processName: value }
  }
}))

// Console-membership reads run a real node-pty fork that never settles under
// fake timers; default to "shell-only" so the degraded-scan guard falls through
// to its existing retirement logic (the degraded-scan behavior itself is
// covered in pty-subprocess-foreground-degraded-scan.test.ts).
vi.mock('../providers/windows-conpty-process-membership', () => ({
  readWindowsConptyProcessIds: () => Promise.resolve(new Set([12345]))
}))

import { createPtySubprocess } from './pty-subprocess'
import {
  mockPtyProcess,
  POWERLEVEL10K_WIZARD_DISABLE_ENV,
  useDaemonPtySubprocessEnv
} from './pty-subprocess-test-harness'

describe('createPtySubprocess', () => {
  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  it('validates the requested Windows cwd before launching WSL on Windows', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      await expect(
        createPtySubprocess({
          sessionId: 'test',
          cols: 80,
          rows: 24,
          cwd: 'C:\\definitely-missing-orca-wsl-cwd',
          shellOverride: 'wsl.exe'
        })
      ).rejects.toThrow(/Working directory "C:\\definitely-missing-orca-wsl-cwd" does not exist/)
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('falls back to /mnt/c before launching WSL when cwd is not a native Windows path', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const cwd = mkdtempSync(join(tmpdir(), 'daemon-pty-wsl-cwd-test-'))

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd,
        shellOverride: 'wsl.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      rmSync(cwd, { recursive: true, force: true })
    }

    const normalizedCwd = cwd.replace(/\\/g, '/')
    const driveMatch = normalizedCwd.match(/^([A-Za-z]):\/?(.*)$/)
    const expectedLinuxCwd = driveMatch
      ? `/mnt/${driveMatch[1].toLowerCase()}${driveMatch[2] ? `/${driveMatch[2]}` : ''}`
      : '/mnt/c'

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['--exec', 'sh', '-c', expect.stringContaining(`cd '${expectedLinuxCwd}'`)],
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })

  it('uses the preferred WSL distro for daemon WSL terminals with Windows cwd', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    // Keep the fixture Windows-shaped even when this test runs on a Linux CI host.
    const cwd = 'C:\\repo'

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Debian', '--exec', 'sh', '-c', expect.stringContaining("cd '/mnt/c/repo'")],
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })

  it('launches WSL for WSL worktree cwd even when a stale Windows shell override is present', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
        shellOverride: 'powershell.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'sh', '-c', expect.stringContaining("cd '/home/jin/repo'")],
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })

  it('does not pass a Windows Codex home into daemon WSL terminals', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
        env: { CODEX_HOME: 'C:\\Users\\jin\\.codex', ORCA_CODEX_HOME: 'C:\\Users\\jin\\.codex' }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'sh', '-c', expect.stringContaining("cd '/home/jin/repo'")],
      expect.objectContaining({
        env: expect.not.objectContaining({
          CODEX_HOME: expect.anything(),
          ORCA_CODEX_HOME: expect.anything()
        })
      })
    )
  })

  it('does not pass a WSL managed Codex home into daemon Windows terminals', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: 'C:\\Users\\jin\\repo',
        env: {
          CODEX_HOME:
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home',
          ORCA_CODEX_HOME:
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.not.objectContaining({
          CODEX_HOME: expect.anything(),
          ORCA_CODEX_HOME: expect.anything()
        })
      })
    )
  })

  it('routes daemon default WSL terminals to the Codex home distro without losing cwd', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const cwd = mkdtempSync(join(tmpdir(), 'daemon-pty-wsl-codex-home-cwd-'))

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd,
        shellOverride: 'wsl.exe',
        env: {
          CODEX_HOME:
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home',
          ORCA_CODEX_HOME:
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      rmSync(cwd, { recursive: true, force: true })
    }

    const normalizedCwd = cwd.replace(/\\/g, '/')
    const driveMatch = normalizedCwd.match(/^([A-Za-z]):\/?(.*)$/)
    const expectedLinuxCwd = driveMatch
      ? `/mnt/${driveMatch[1].toLowerCase()}${driveMatch[2] ? `/${driveMatch[2]}` : ''}`
      : '/mnt/c'

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'sh', '-c', expect.stringContaining(`cd '${expectedLinuxCwd}'`)],
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: '/home/jin/.local/share/orca/codex-accounts/a/home',
          ORCA_CODEX_HOME: '/home/jin/.local/share/orca/codex-accounts/a/home',
          WSLENV: expect.stringContaining('CODEX_HOME')
        })
      })
    )
  })

  it('preserves an explicit Linux Codex home in daemon WSL terminals', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
        env: { CODEX_HOME: '/home/jin/.codex-alt' }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'sh', '-c', expect.stringContaining("cd '/home/jin/repo'")],
      expect.objectContaining({
        env: expect.objectContaining({ CODEX_HOME: '/home/jin/.codex-alt' })
      })
    )
  })

  it('marks Orca terminal handles for WSL env import in daemon WSL terminals', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const savedCodexHome = process.env.CODEX_HOME
    const savedOrcaCodexHome = process.env.ORCA_CODEX_HOME

    Object.defineProperty(process, 'platform', { value: 'win32' })
    delete process.env.CODEX_HOME
    delete process.env.ORCA_CODEX_HOME

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
        env: {
          ORCA_TERMINAL_HANDLE: 'term_wsl',
          ORCA_HERMES_STARTUP_QUERY: 'line one\nline two',
          WSLENV: 'FOO/u'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
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
    expect(spawnCall[1]).toEqual(expect.any(Array))
    expect(spawnCall[2].env.ORCA_TERMINAL_HANDLE).toBe('term_wsl')
    // Why: the daemon inherits optional agent-hook env in development. This
    // test owns only the terminal handle and Powerlevel10k WSLENV contract.
    expect(spawnCall[2].env.WSLENV?.split(':')).toEqual(
      expect.arrayContaining([
        'FOO/u',
        'ORCA_TERMINAL_HANDLE/u',
        'ORCA_HERMES_STARTUP_QUERY',
        POWERLEVEL10K_WIZARD_DISABLE_ENV
      ])
    )
  })

  it('does not mark deleted Powerlevel10k wizard env for daemon WSL import', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
        envToDelete: [POWERLEVEL10K_WIZARD_DISABLE_ENV]
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const spawnCall = spawnMock.mock.calls.at(-1)!
    expect(spawnCall[0]).toBe('wsl.exe')
    expect(spawnCall[2].env[POWERLEVEL10K_WIZARD_DISABLE_ENV]).toBeUndefined()
    expect(spawnCall[2].env.WSLENV ?? '').not.toContain(POWERLEVEL10K_WIZARD_DISABLE_ENV)
  })

  it.each(['/home/jin/repo/subdir', '/a', '/c'])(
    'keeps daemon WSL split panes in their distro when cwd is POSIX (%s)',
    async (cwd) => {
      const proc = mockPtyProcess()
      spawnMock.mockReturnValue(proc)
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')

      Object.defineProperty(process, 'platform', { value: 'win32' })

      try {
        await createPtySubprocess({
          sessionId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo@@deadbeef',
          cols: 80,
          rows: 24,
          cwd,
          shellOverride: 'wsl.exe'
        })
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }

      expect(validateWorkingDirectoryMock).toHaveBeenCalledWith(
        `\\\\wsl.localhost\\Ubuntu${cwd.replaceAll('/', '\\')}`,
        expect.anything()
      )
      expect(spawnMock).toHaveBeenCalledWith(
        'wsl.exe',
        ['-d', 'Ubuntu', '--exec', 'sh', '-c', expect.stringContaining(`cd '${cwd}'`)],
        expect.objectContaining({ cwd: expect.any(String) })
      )
    }
  )
})
