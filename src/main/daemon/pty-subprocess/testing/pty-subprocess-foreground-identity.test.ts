import type * as PtySpawnValidationTypes from '../../../providers/working-directory/validation'
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
vi.mock('../../../providers/shell-launch/windows/powershell-executable', () => ({
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
    getNodePtySpawnHelperCandidates: () => [import.meta.filename],
    resolveUnixShellPath: resolveUnixShellPathMock
  }
})

vi.mock('../../../providers/working-directory/validation', async (importOriginal) => {
  const actual = await importOriginal<typeof PtySpawnValidationTypes>()
  return {
    ...actual,
    validateWorkingDirectory: validateWorkingDirectoryMock,
    validateWorkingDirectoryAsync: validateWorkingDirectoryMock
  }
})

vi.mock('../../../providers/foreground/agent-process', () => ({
  resolveAgentForegroundProcessWithAvailability: async (...args: unknown[]) => {
    const value = await resolveAgentForegroundProcessMock(...args)
    return value && typeof value === 'object' && 'available' in value
      ? value
      : { available: true, processName: value }
  }
}))

vi.mock('../../../providers/foreground/windows/pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: () => new Set([12345]),
  isWindowsPtyJobReadable: () => true
}))

import { createPtySubprocess } from '../pty-subprocess'
import { mockPtyProcess, useDaemonPtySubprocessEnv } from './pty-subprocess-test-harness'

describe('createPtySubprocess', () => {
  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  it('awaits a fresh delayed Windows scan instead of serving the shell fallback', async () => {
    const proc = mockPtyProcess()
    proc.process = 'powershell.exe'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let resolveFresh!: (processName: string) => void
    resolveAgentForegroundProcessMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveFresh = resolve
      })
    )

    try {
      const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      const confirmation = handle.confirmForegroundProcess!()
      let settled = false
      void confirmation.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      resolveFresh('droid')
      await expect(confirmation).resolves.toBe('droid')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledExactlyOnceWith(
        proc.pid,
        'powershell.exe',
        expect.objectContaining({ fresh: true, forceProcessScan: true })
      )
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('returns null when a fresh Windows confirmation scan is unavailable', async () => {
    const proc = mockPtyProcess()
    proc.process = 'powershell.exe'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    resolveAgentForegroundProcessMock.mockResolvedValue({
      available: false,
      processName: 'powershell.exe'
    })

    try {
      const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      await expect(handle.confirmForegroundProcess!()).resolves.toBeNull()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('returns null when a recognized Windows fallback disappears during confirmation', async () => {
    const proc = mockPtyProcess()
    proc.process = 'droid'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    resolveAgentForegroundProcessMock.mockResolvedValue({
      available: true,
      processName: null
    })

    try {
      const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
      await expect(handle.confirmForegroundProcess!()).resolves.toBeNull()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('does not let stale shell enrichment clear a newer direct agent foreground cache', async () => {
    const proc = mockPtyProcess()
    proc.process = 'powershell.exe'
    spawnMock.mockReturnValue(proc)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let resolveForeground!: (processName: string) => void
    resolveAgentForegroundProcessMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveForeground = resolve
      })
    )

    try {
      const handle = await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24
      })

      expect(handle.getForegroundProcess()).toBe('powershell.exe')
      proc.process = 'codex'
      expect(handle.getForegroundProcess()).toBe('codex')

      resolveForeground('powershell.exe')
      await Promise.resolve()
      await Promise.resolve()

      proc.process = 'powershell.exe'
      expect(handle.getForegroundProcess()).toBe('codex')
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })
})
