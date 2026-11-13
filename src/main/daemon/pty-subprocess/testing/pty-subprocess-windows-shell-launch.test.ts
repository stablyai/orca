import type * as PtySpawnValidationTypes from '../../../providers/working-directory-validation'
import { describe, expect, it, vi } from 'vitest'
import { setImmediate as nextNativeTurn } from 'node:timers/promises'
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
import {
  createPtyProcessEventEmitter,
  mockPtyProcess,
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

  it('delivers output and exit that land while ConPTY startup is still being confirmed', async () => {
    const proc = { ...mockPtyProcess(), ...createPtyProcessEventEmitter() }
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      let published = false
      const pending = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 }).then(
        (handle) => {
          published = true
          return handle
        }
      )
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
      await nextNativeTurn()
      expect(published).toBe(false)
      proc._simulateData('\x1b[1t')
      proc._simulateExit(7)
      const handle = await pending
      const data: string[] = []
      const exitCode = new Promise<number>((resolve) => handle.onExit((code) => resolve(code)))
      handle.onData((chunk) => data.push(chunk))
      expect(await exitCode).toBe(7)
      expect(data[0]).toBe('\x1b[1t')
      expect(spawnMock).toHaveBeenCalledOnce()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })
})
