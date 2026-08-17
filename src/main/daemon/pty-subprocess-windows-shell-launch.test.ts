// Native Windows shell launch: PowerShell implementations, cmd.exe and Git Bash.
import { describe, expect, it, vi } from 'vitest'
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
import { mockPtyProcess, useDaemonPtySubprocessEnv } from './pty-subprocess-test-harness'

const POWERSHELL_OSC133_COMMAND_ARGS = ['-NoLogo', '-NoExit', '-EncodedCommand', expect.any(String)]
const CODEX_LAUNCH_PREFLIGHT = 'C:\\Program Files\\Orca\\orca.exe'

describe('createPtySubprocess', () => {
  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  it('keeps powershell.exe when the inbox PowerShell implementation is selected on Windows', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(true)

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { COMSPEC: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
        terminalWindowsPowerShellImplementation: 'powershell.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      WINDOWS_POWERSHELL_ABS,
      POWERSHELL_OSC133_COMMAND_ARGS,
      expect.any(Object)
    )
  })

  it('spawns pwsh.exe when PowerShell 7 is selected and available on Windows', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(true)

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { COMSPEC: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
        terminalWindowsPowerShellImplementation: 'pwsh.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      PWSH7_ABS,
      POWERSHELL_OSC133_COMMAND_ARGS,
      expect.any(Object)
    )
  })

  it('keeps PowerShell 7 selected when the pwsh availability probe is cold-false on Windows', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(false)

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { COMSPEC: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
        terminalWindowsPowerShellImplementation: 'pwsh.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      PWSH7_ABS,
      POWERSHELL_OSC133_COMMAND_ARGS,
      expect.any(Object)
    )
    expect(isPwshAvailableMock).not.toHaveBeenCalled()
  })

  it('keeps a pwsh.exe shellOverride when the pwsh availability probe is cold-false on Windows', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(false)

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        shellOverride: 'pwsh.exe',
        terminalWindowsPowerShellImplementation: 'pwsh.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      PWSH7_ABS,
      POWERSHELL_OSC133_COMMAND_ARGS,
      expect.any(Object)
    )
    expect(isPwshAvailableMock).not.toHaveBeenCalled()
  })

  it('ignores the PowerShell implementation setting for cmd.exe on Windows', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    isPwshAvailableMock.mockReturnValue(true)

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        shellOverride: 'cmd.exe',
        terminalWindowsPowerShellImplementation: 'pwsh.exe',
        env: { ORCA_CODEX_LAUNCH_PREFLIGHT: CODEX_LAUNCH_PREFLIGHT }
      })
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
        env: expect.objectContaining({ ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE: '"' })
      })
    )
  })

  it('embeds short PowerShell startup commands in the Windows shell launch', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    let handle: Awaited<ReturnType<typeof createPtySubprocess>>
    try {
      handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo\\orca',
        shellOverride: 'powershell.exe',
        command: "& 'codex' '--no-alt-screen'"
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const lastCall = spawnMock.mock.calls.at(-1)!
    const encoded = String(lastCall[1][3])
    const command = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(command.trimEnd().endsWith("& 'codex' '--no-alt-screen'")).toBe(true)
    expect(handle!.startupCommandDeliveredInShellArgs).toBe(true)
  })

  it('keeps oversized Windows startup commands on PTY stdin delivery', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')

    Object.defineProperty(process, 'platform', { value: 'win32' })

    let handle: Awaited<ReturnType<typeof createPtySubprocess>>
    try {
      handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo\\orca',
        shellOverride: 'cmd.exe',
        command: `codex ${'x'.repeat(7000)}`,
        env: { ORCA_CODEX_LAUNCH_PREFLIGHT: CODEX_LAUNCH_PREFLIGHT }
      })
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
      expect.any(Object)
    )
    expect(handle!.startupCommandDeliveredInShellArgs).toBeUndefined()
  })

  it('launches Git Bash with login args and CHERE_INVOKING on Windows', async () => {
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
        shellOverride: 'C:\\PortableGit\\bin\\bash.exe',
        env: { ORCA_CODEX_LAUNCH_PREFLIGHT: CODEX_LAUNCH_PREFLIGHT }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\PortableGit\\bin\\bash.exe',
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
          ORCA_CODEX_LAUNCH_PREFLIGHT: CODEX_LAUNCH_PREFLIGHT
        })
      })
    )
  })

  it('rejects a missing explicit native Windows cwd before node-pty spawn', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      await expect(
        createPtySubprocess({
          sessionId: 'test',
          cols: 80,
          rows: 24,
          cwd: 'C:\\definitely-missing-orca-cwd',
          shellOverride: 'powershell.exe'
        })
      ).rejects.toThrow(/Working directory "C:\\definitely-missing-orca-cwd" does not exist/)
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('normalizes MSYS drive cwd before spawning daemon PowerShell on Windows', async () => {
    const proc = mockPtyProcess()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    spawnMock.mockImplementation((_shell, _args, options) => {
      if (options.cwd === '/c/Users/alice/project') {
        throw new Error('Cannot create process, error code: 267')
      }
      return proc
    })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '/c/Users/alice/project',
        shellOverride: 'powershell.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      WINDOWS_POWERSHELL_ABS,
      POWERSHELL_OSC133_COMMAND_ARGS,
      expect.objectContaining({ cwd: 'C:\\Users\\alice\\project' })
    )
  })

  it('adds shell and cwd context when node-pty reports File not found on Windows', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    spawnMock.mockImplementation(() => {
      throw new Error('File not found: ')
    })
    const previousVersion = process.env.ORCA_APP_VERSION
    process.env.ORCA_APP_VERSION = '1.4.178-test'

    try {
      await expect(
        createPtySubprocess({
          sessionId: 'test',
          cols: 80,
          rows: 24,
          shellOverride: 'not-a-real-shell.exe'
        })
      ).rejects.toThrow(
        /Daemon failed to spawn shell "not-a-real-shell\.exe" with cwd ".+": File not found:.*orca: 1\.4\.178-test/
      )
    } finally {
      if (previousVersion === undefined) {
        delete process.env.ORCA_APP_VERSION
      } else {
        process.env.ORCA_APP_VERSION = previousVersion
      }
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })
})
