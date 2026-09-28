import type { BunPtySpawnArgs } from './pty-subprocess/bun-pty-process-contract'
// Native Windows shell launch: PowerShell implementations, cmd.exe and Git Bash.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PtySpawnValidation from '../providers/pty-spawn-validation'

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

vi.mock('./pty-subprocess/bun-pty-process', () => ({
  canUseBunPty: () => true,
  spawnBunPty: ({ file, args, ...options }: BunPtySpawnArgs) =>
    spawnMock(file, args, { ...options, name: options.env.TERM ?? 'xterm-256color' })
}))

vi.mock('../pwsh', () => ({
  isPwshAvailable: isPwshAvailableMock,
  isPwshAvailableAsync: isPwshAvailableMock
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

vi.mock('../providers/pty-spawn-validation', async (importOriginal) => {
  const actual = await importOriginal<typeof PtySpawnValidation>()
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

import { createPtySubprocess } from './pty-subprocess'
import { mockPtyProcess, useDaemonPtySubprocessEnv } from './pty-subprocess-test-harness'

const POWERSHELL_OSC133_COMMAND_ARGS = ['-NoLogo', '-NoExit', '-EncodedCommand', expect.any(String)]

describe('createPtySubprocess', () => {
  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() =>
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  )
  afterEach(() => Object.defineProperty(process, 'platform', platform))

  it('waits for the async automatic-shell probe before selecting PowerShell 7', async () => {
    let release!: (available: boolean) => void
    isPwshAvailableMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve
      })
    )
    spawnMock.mockReturnValue(mockPtyProcess())
    const pending = createPtySubprocess({
      sessionId: 'automatic-shell',
      cols: 80,
      rows: 24,
      shellOverride: 'powershell.exe'
    })
    await vi.waitFor(() => expect(isPwshAvailableMock).toHaveBeenCalledOnce())
    expect(spawnMock).not.toHaveBeenCalled()
    release(true)
    await pending
    expect(spawnMock).toHaveBeenCalledWith(
      PWSH7_ABS,
      POWERSHELL_OSC133_COMMAND_ARGS,
      expect.any(Object)
    )
  })

  it('cancels the caller waiting for a shell probe without publishing a later native spawn', async () => {
    let release!: (available: boolean) => void
    isPwshAvailableMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve
      })
    )
    const abort = new AbortController()
    const pending = createPtySubprocess({
      sessionId: 'canceled-shell',
      cols: 80,
      rows: 24,
      shellOverride: 'powershell.exe',
      cancelSignal: abort.signal
    })
    const rejected = expect(pending).rejects.toThrow('Attach canceled')
    await vi.waitFor(() => expect(isPwshAvailableMock).toHaveBeenCalledOnce())
    abort.abort()
    await rejected
    release(true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not wait on availability for an explicit PowerShell 7 selection', async () => {
    spawnMock.mockReturnValue(mockPtyProcess())
    await createPtySubprocess({
      sessionId: 'explicit-shell',
      cols: 80,
      rows: 24,
      shellOverride: 'pwsh.exe'
    })
    expect(isPwshAvailableMock).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledWith(
      PWSH7_ABS,
      POWERSHELL_OSC133_COMMAND_ARGS,
      expect.any(Object)
    )
  })
})
