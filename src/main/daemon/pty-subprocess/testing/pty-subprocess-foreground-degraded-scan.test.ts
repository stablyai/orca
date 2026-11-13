import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  spawnMock,
  isPwshAvailableMock,
  resolveAgentForegroundProcessMock,
  readConptyMock,
  jobReadableMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  isPwshAvailableMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn(),
  readConptyMock: vi.fn(),
  jobReadableMock: vi.fn()
}))

vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('../../../pty/shell-startup/pwsh', () => ({ isPwshAvailable: isPwshAvailableMock }))

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

vi.mock('../../../providers/foreground/agent-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('../../../providers/foreground/windows/pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readConptyMock(...args),
  isWindowsPtyJobReadable: () => jobReadableMock()
}))

import { createPtySubprocess } from '../pty-subprocess'
import { createConptyPreludeSender } from './pty-subprocess-test-harness'

const BASE_TIME_MS = 1_000_000

function mockPtyProcess(processName: string, pid = 12345) {
  const sendConptyPrelude = createConptyPreludeSender()
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: processName,
    onData: vi.fn((cb: (data: string) => void) => {
      sendConptyPrelude(cb)
      return { dispose: vi.fn() }
    }),
    onExit: vi.fn(() => ({ dispose: vi.fn() }))
  }
}

async function flushAsyncTicks(count = 12): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

async function readForegroundAt(
  handle: { getForegroundProcess: () => string | null },
  atMs: number
): Promise<string | null> {
  vi.setSystemTime(BASE_TIME_MS + atMs)
  const foreground = handle.getForegroundProcess()
  await flushAsyncTicks()
  return foreground
}

describe('daemon pty foreground degraded-scan handling', () => {
  let platform: PropertyDescriptor | undefined
  let previousUserDataPath: string | undefined
  let userDataPath: string

  beforeEach(() => {
    spawnMock.mockReset()
    isPwshAvailableMock.mockReset()
    isPwshAvailableMock.mockReturnValue(false)
    resolveAgentForegroundProcessMock.mockReset()
    readConptyMock.mockReset()
    readConptyMock.mockReturnValue(null)
    jobReadableMock.mockReset()
    jobReadableMock.mockReturnValue(true)
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-pty-degraded-scan-test-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(BASE_TIME_MS)
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(userDataPath, { recursive: true, force: true })
  })

  async function spawnWindowsShell() {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const proc = mockPtyProcess('powershell.exe')
    spawnMock.mockReturnValue(proc)
    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    return { proc, handle }
  }

  it('keeps raw confirmation separate from a known detached writer decision', async () => {
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude', processId: 999 })
      .mockResolvedValue({ available: true, processName: 'powershell.exe' })
    readConptyMock.mockReturnValue(new Set([12345, 999]))
    const { handle } = await spawnWindowsShell()
    await readForegroundAt(handle, 0)
    if (!handle.confirmForegroundProcess) {
      throw new Error('fixture confirmer missing')
    }
    vi.setSystemTime(BASE_TIME_MS + 40_000)
    resolveAgentForegroundProcessMock.mockClear()
    expect(await handle.confirmForegroundProcess({ decision: true })).toBe('claude')
    expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(1)
    expect(await handle.confirmForegroundProcess()).toBe('powershell.exe')
    expect(resolveAgentForegroundProcessMock).toHaveBeenLastCalledWith(
      12345,
      'powershell.exe',
      expect.not.objectContaining({ anchorProcessId: 999 })
    )
  })
})
