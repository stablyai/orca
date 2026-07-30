// Guards the daemon foreground identity against Windows scan degradation: a
// timed-out CIM scan (available:false) or an incomplete snapshot (available:true
// with the agent row missing) must not retire a still-working agent and make
// the coordinator read the shell as a false "agent done". Console presence is
// the arbiter of a real exit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { spawnMock, isPwshAvailableMock, resolveAgentForegroundProcessMock, readConptyMock } =
  vi.hoisted(() => ({
    spawnMock: vi.fn(),
    isPwshAvailableMock: vi.fn(),
    resolveAgentForegroundProcessMock: vi.fn(),
    readConptyMock: vi.fn()
  }))

vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('../pwsh', () => ({ isPwshAvailable: isPwshAvailableMock }))

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

vi.mock('../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('../providers/windows-conpty-process-membership', () => ({
  readWindowsConptyProcessIds: (...args: unknown[]) => readConptyMock(...args)
}))

import { createPtySubprocess } from './pty-subprocess'

const BASE_TIME_MS = 1_000_000

function mockPtyProcess(processName: string, pid = 12345) {
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: processName,
    onData: vi.fn(() => ({ dispose: vi.fn() })),
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
    readConptyMock.mockResolvedValue(null)
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

  function spawnWindowsShell() {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const proc = mockPtyProcess('powershell.exe')
    spawnMock.mockReturnValue(proc)
    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    return { proc, handle }
  }

  it('keeps a cached agent across a degraded (timed-out) scan', async () => {
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: false, processName: null })
    const { handle } = spawnWindowsShell()

    await readForegroundAt(handle, 0) // establishes 'claude'
    expect(await readForegroundAt(handle, 1_000)).toBe('claude') // refresh returns degraded → keep
    // Past the 1s TTL with a shell fallback: pre-fix this returned the shell.
    expect(await readForegroundAt(handle, 2_500)).toBe('claude')
    expect(readConptyMock).not.toHaveBeenCalled()
  })

  it('keeps a cached agent when a scan finds no agent but the console still has a child', async () => {
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockResolvedValue(new Set([12345, 999])) // child still attached
    const { handle } = spawnWindowsShell()

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 1_000)).toBe('claude')
    expect(await readForegroundAt(handle, 2_500)).toBe('claude')
  })

  it('retires a cached agent when a scan finds no agent and the console is shell-only', async () => {
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockResolvedValue(new Set([12345]))
    const { handle } = spawnWindowsShell()

    await readForegroundAt(handle, 0)
    await readForegroundAt(handle, 1_000) // refresh clears the cache
    expect(await readForegroundAt(handle, 1_100)).toBe('powershell.exe')
    expect(readConptyMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a cached agent when the console-membership probe is unavailable', async () => {
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockResolvedValue(null)
    const { handle } = spawnWindowsShell()

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 1_000)).toBe('claude')
    expect(await readForegroundAt(handle, 2_500)).toBe('claude')
    expect(readConptyMock).toHaveBeenCalledTimes(2)
  })
})
