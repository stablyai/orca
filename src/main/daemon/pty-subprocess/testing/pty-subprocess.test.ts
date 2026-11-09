import type * as PtySpawnValidationTypes from '../../../providers/working-directory-validation'
import { describe, expect, it, vi } from 'vitest'
import type * as LocalPtyUtils from '../../../providers/local-pty/local-pty-executable-spawn'

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

vi.mock('../../../pty/shell-startup/pwsh', () => ({
  isPwshAvailable: isPwshAvailableMock
}))

// Keep PowerShell resolution deterministic on non-Windows hosts.
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('../../../providers/windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('../../../providers/local-pty/local-pty-executable-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalPtyUtils>()
  return {
    ...actual,
    resolveUnixShellPath: resolveUnixShellPathMock
  }
})

vi.mock('../../../providers/working-directory-validation', async (importOriginal) => {
  const actual = await importOriginal<typeof PtySpawnValidationTypes>()
  return {
    ...actual,
    validateWorkingDirectory: validateWorkingDirectoryMock,
    validateWorkingDirectoryAsync: validateWorkingDirectoryMock
  }
})

vi.mock('../../../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: async (...args: unknown[]) => {
    const value = await resolveAgentForegroundProcessMock(...args)
    return value && typeof value === 'object' && 'available' in value
      ? value
      : { available: true, processName: value }
  }
}))

vi.mock('../../../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: () => new Set([12345]),
  isWindowsPtyJobReadable: () => true
}))
import { createPtySubprocess } from '../pty-subprocess'
import { useDaemonPtySubprocessEnv } from './pty-subprocess-test-harness'

describe('createPtySubprocess', () => {
  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
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
      cwd: process.platform === 'win32' ? 'C:\\orca-cwd-fixture' : '/tmp/orca-cwd-fixture',
      isCanceled: () => canceled
    })
    await vi.waitFor(() => expect(validateWorkingDirectoryMock).toHaveBeenCalled())

    canceled = true
    releaseValidation()

    await expect(spawning).rejects.toThrow('Attach canceled for session canceled-validation')
    expect(spawnMock).not.toHaveBeenCalled()
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
})
