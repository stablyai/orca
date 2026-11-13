import type * as PtySpawnValidationTypes from '../../../providers/working-directory/validation'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LocalPtyUtils from '../../../providers/local-pty/local-pty-executable-spawn'
import type * as PosixPtyProcessTable from '../../../pty/process-retirement/posix-pty-process-table'

const {
  spawnMock,
  isPwshAvailableMock,
  validateWorkingDirectoryMock,
  resolveUnixShellPathMock,
  resolveAgentForegroundProcessMock,
  readProcessTableMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  readProcessTableMock: vi.fn<(rootPid: number) => Promise<string>>(),
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

// Fixture pids must never be looked up in, or signalled through, the real host process table.
vi.mock('../../../pty/process-retirement/posix-pty-process-table', async (importOriginal) => ({
  ...(await importOriginal<typeof PosixPtyProcessTable>()),
  readPosixPtyProcessTable: readProcessTableMock
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
  beforeEach(() => {
    readProcessTableMock.mockReset()
    readProcessTableMock.mockResolvedValue('')
  })

  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  it('replays pre-listener data before a pre-listener exit', async () => {
    const proc = mockPtyProcess()
    spawnMock.mockReturnValue(proc)

    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    proc._simulateData('last output\r\n')
    proc._simulateExit(7)
    const data: string[] = []
    const codes: number[] = []
    handle.onData((d) => data.push(d))
    handle.onExit((code) => codes.push(code))

    expect(data).toEqual(['last output\r\n'])
    expect(codes).toEqual([7])
  })
})
