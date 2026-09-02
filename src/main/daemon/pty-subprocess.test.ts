// Spawn setup: node-pty launch options, Unix shell resolution and daemon cwd repair.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
vi.mock('../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: () => new Set([12345]),
  isWindowsPtyJobReadable: () => true
}))

import { createPtySubprocess, checkPtySpawnHealth } from './pty-subprocess'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION } from './types'
import {
  mockPtyProcess,
  POWERLEVEL10K_WIZARD_DISABLE_ENV,
  stubMissingDaemonCwd,
  useDaemonPtySubprocessEnv
} from './pty-subprocess-test-harness'

const itOnMacHost = process.platform === 'darwin' ? it : it.skip
const itOnPosixHost = process.platform === 'win32' ? it.skip : it

describe('createPtySubprocess', () => {
  const ptyEnv = useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  it('spawns node-pty with correct options', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const onMacosTccSpawnStrategy = vi.fn()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        env: { SHELL: '/bin/bash', FOO: 'bar' },
        onMacosTccSpawnStrategy
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/bash',
      expect.any(Array),
      expect.objectContaining({
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        name: 'xterm-256color'
      })
    )
    expect(onMacosTccSpawnStrategy).toHaveBeenCalledWith('direct')
  })

  it('does not spawn after cancellation wins during async cwd validation', async () => {
    let releaseValidation: () => void = () => {}
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve
    })
    validateWorkingDirectoryMock.mockImplementationOnce(() => validationGate)
    let canceled = false

    const spawning = createPtySubprocess({
      sessionId: 'canceled-validation',
      cols: 80,
      rows: 24,
      isCanceled: () => canceled
    })
    await vi.waitFor(() => expect(validateWorkingDirectoryMock).toHaveBeenCalled())

    canceled = true
    releaseValidation()

    await expect(spawning).rejects.toThrow('Attach canceled for session canceled-validation')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not report a spawn strategy when node-pty fails before launch', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    const onMacosTccSpawnStrategy = vi.fn()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await expect(
        createPtySubprocess({
          sessionId: 'test',
          cols: 80,
          rows: 24,
          env: { SHELL: '/bin/bash' },
          onMacosTccSpawnStrategy
        })
      ).rejects.toThrow('spawn failed')
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(onMacosTccSpawnStrategy).not.toHaveBeenCalled()
  })

  it('uses a new daemon protocol for the macOS login preflight host behavior', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThan(22)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(22)
  })

  it('uses a new daemon protocol for daemon-local Codex env ownership', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThan(22)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(22)
  })

  it('resolves a missing Unix default before spawning node-pty', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    resolveUnixShellPathMock.mockReturnValue('/bin/sh')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const previousShell = process.env.SHELL
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    delete process.env.SHELL

    try {
      await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24, env: {} })

      expect(resolveUnixShellPathMock).toHaveBeenCalledWith('/bin/zsh')
      expect(spawnMock).toHaveBeenCalledWith(
        '/bin/sh',
        ['-l'],
        expect.objectContaining({ env: expect.objectContaining({ SHELL: '/bin/sh' }) })
      )
      expect(warn).toHaveBeenCalledWith(
        '[daemon/pty] Preferred shell "/bin/zsh" is unavailable, fell back to "/bin/sh"'
      )
    } finally {
      warn.mockRestore()
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      if (previousShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = previousShell
      }
    }
  })

  it('derives shell-ready launch config from the resolved fallback shell', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    resolveUnixShellPathMock.mockReturnValue('/bin/sh')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const previousShell = process.env.SHELL
    const previousFeatures = process.env.ORCA_SHELL_FEATURES
    const previousZdotdir = process.env.ZDOTDIR
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    delete process.env.SHELL
    // Why: the test runner itself can execute inside an Orca-wrapped shell
    // whose exported wrapper vars would leak through the process.env spread.
    delete process.env.ORCA_SHELL_FEATURES
    delete process.env.ZDOTDIR

    try {
      const handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: {},
        command: 'echo hi'
      })

      expect(handle.shellPath).toBe('/bin/sh')
      const [shellPath, shellArgs, spawnOptions] = spawnMock.mock.calls[0]
      expect(shellPath).toBe('/bin/sh')
      expect(shellArgs).toEqual(['-l'])
      // A launch config derived from the missing preferred zsh would inject
      // ZDOTDIR and ORCA_SHELL_FEATURES; /bin/sh must spawn without them.
      expect(spawnOptions.env.ZDOTDIR).toBeUndefined()
      expect(spawnOptions.env.ORCA_SHELL_FEATURES).toBeUndefined()
      expect(spawnOptions.env.SHELL).toBe('/bin/sh')
    } finally {
      warn.mockRestore()
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      if (previousShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = previousShell
      }
      if (previousFeatures === undefined) {
        delete process.env.ORCA_SHELL_FEATURES
      } else {
        process.env.ORCA_SHELL_FEATURES = previousFeatures
      }
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
    }
  })

  it('surfaces the no-executable-shell error before node-pty forks', async () => {
    resolveUnixShellPathMock.mockImplementation(() => {
      throw new Error('No executable Unix shell found (tried: /bin/zsh, /bin/bash, /bin/sh)')
    })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })

    try {
      await expect(
        createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24, env: {} })
      ).rejects.toThrow('No executable Unix shell found')
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('uses bundled ConPTY for native Windows daemon terminals', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo',
        env: { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ useConptyDll: true })
    )
  })

  it('suppresses the first-run Powerlevel10k wizard for daemon terminals', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        env: { SHELL: '/bin/bash' }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const spawnCall = spawnMock.mock.calls.at(-1)!
    expect(spawnCall[2].env[POWERLEVEL10K_WIZARD_DISABLE_ENV]).toBe('true')
  })

  itOnMacHost('repairs a deleted macOS daemon cwd before spawning node-pty', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const terminalCwd = process.cwd()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const { restoreCwdStubs, chdirSpy } = stubMissingDaemonCwd()

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: terminalCwd,
        env: { SHELL: '/bin/bash' }
      })

      expect(chdirSpy).toHaveBeenCalledWith(ptyEnv.userDataPath)
    } finally {
      restoreCwdStubs()
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    // The sync subprocess layer consumes the capability prepared by its async
    // daemon boundary; this cwd-repair test deliberately exercises it unprepared.
    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/bash',
      expect.any(Array),
      expect.objectContaining({ cwd: terminalCwd })
    )
  })

  itOnPosixHost('repairs a deleted POSIX daemon cwd before Linux node-pty spawn', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const terminalCwd = process.cwd()
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const { restoreCwdStubs, chdirSpy } = stubMissingDaemonCwd()

    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: terminalCwd,
        env: { SHELL: '/bin/bash' }
      })

      expect(chdirSpy).toHaveBeenCalledWith(ptyEnv.userDataPath)
    } finally {
      restoreCwdStubs()
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/bash',
      expect.any(Array),
      expect.objectContaining({ cwd: terminalCwd })
    )
  })

  it('uses SHELL env or defaults to /bin/zsh on non-Windows', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })

    const shellArg = spawnMock.mock.calls[0][0]
    expect(typeof shellArg).toBe('string')
    expect(shellArg.length).toBeGreaterThan(0)
  })

  it('allows an explicitly requested plain daemon shell at POSIX root', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24, cwd: '/' })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: '/' })
    )
  })

  it('falls back to the safe default cwd for daemon agent startup without an explicit cwd', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    spawnMock.mockClear()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const origHome = process.env.HOME
    // Pin HOME so we assert the exact resolved candidate, not just non-root-ness —
    // catches regressions where resolveSafePtyDefaultCwd picks an unintended home.
    process.env.HOME = '/home/testuser'

    try {
      // Why: omitted cwd resolves to a safe default home; guard must not reject before fallback (#9578).
      await expect(
        createPtySubprocess({
          sessionId: 'test',
          cols: 80,
          rows: 24,
          command: 'opencode'
        })
      ).resolves.not.toThrow()

      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: '/home/testuser' })
      )
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      if (origHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = origHome
      }
    }
  })

  it('rejects daemon automatic agent startup at POSIX root', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    spawnMock.mockClear()

    try {
      await expect(
        createPtySubprocess({
          sessionId: 'test',
          cols: 80,
          rows: 24,
          cwd: '/',
          command: 'claude'
        })
      ).rejects.toThrow(/requires a non-root workspace/)
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects a missing explicit POSIX cwd before node-pty spawn', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    spawnMock.mockClear()

    try {
      await expect(
        createPtySubprocess({
          sessionId: 'test',
          cols: 80,
          rows: 24,
          cwd: '/definitely-missing-orca-cwd'
        })
      ).rejects.toThrow(/definitely-missing-orca-cwd/)
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('combines HOMEDRIVE and HOMEPATH for Windows default cwd', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const originalUserProfile = process.env.USERPROFILE
    const originalHomeDrive = process.env.HOMEDRIVE
    const originalHomePath = process.env.HOMEPATH

    Object.defineProperty(process, 'platform', { value: 'win32' })
    delete process.env.USERPROFILE
    process.env.HOMEDRIVE = 'D:'
    process.env.HOMEPATH = '\\Users\\orca'

    try {
      await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
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

describe('checkPtySpawnHealth (retry on transient failure)', () => {
  let previousUserDataPath: string | undefined
  let userDataPath: string

  beforeEach(() => {
    spawnMock.mockReset()
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-pty-health-test-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(userDataPath, { recursive: true, force: true })
  })

  // Why: a busy machine right after an upgrade can make one probe fail; the
  // retry must keep a genuinely healthy daemon out of degraded mode. Windows
  // short-circuits checkPtySpawnHealth, so this is a POSIX-only behavior.
  itOnPosixHost(
    'retries once and resolves when the first probe fails but the second succeeds',
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      spawnMock
        .mockImplementationOnce(() => {
          const proc = mockPtyProcess()
          queueMicrotask(() => proc._simulateExit(1))
          return proc
        })
        .mockImplementationOnce(() => {
          const proc = mockPtyProcess()
          queueMicrotask(() => proc._simulateExit(0))
          return proc
        })

      await expect(checkPtySpawnHealth()).resolves.toBeUndefined()
      expect(spawnMock).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    }
  )

  itOnPosixHost('rejects after exhausting retries when every probe fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    spawnMock.mockImplementation(() => {
      const proc = mockPtyProcess()
      queueMicrotask(() => proc._simulateExit(1))
      return proc
    })

    await expect(checkPtySpawnHealth()).rejects.toThrow(/exited with code 1/)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
