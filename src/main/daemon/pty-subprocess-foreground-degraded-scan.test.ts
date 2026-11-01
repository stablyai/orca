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

vi.mock('../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readConptyMock(...args),
  isWindowsPtyJobReadable: () => jobReadableMock()
}))

import { createPtySubprocess } from './pty-subprocess'
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

  it('keeps a cached agent across a degraded (timed-out) scan', async () => {
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: false, processName: null })
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 1_000)).toBe('claude')
    expect(await readForegroundAt(handle, 2_500)).toBe('claude')
    expect(readConptyMock).not.toHaveBeenCalled()
  })

  it('keeps a cached agent, for a bounded time, when the job still has a descendant', async () => {
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockReturnValue(new Set([12345, 999]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 1_000)).toBe('claude')
    expect(await readForegroundAt(handle, 2_500)).toBe('claude')
  })

  it('stops holding a dead agent once the job answer is only a superset', async () => {
    // Detached job members can outlive the agent; unanchored membership needs an age bound.
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockReturnValue(new Set([12345, 999]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 2_500)).toBe('claude')
    await readForegroundAt(handle, 40_000)
    expect(await readForegroundAt(handle, 40_100)).toBe('powershell.exe')
  })

  it('restores the idle refresh backoff once the dead identity is gone', async () => {
    // Retiring stale identities also restores the slower idle refresh tier.
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockReturnValue(new Set([12345, 999]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    await readForegroundAt(handle, 40_000)
    const scansAfterExpiry = resolveAgentForegroundProcessMock.mock.calls.length

    await readForegroundAt(handle, 41_000)
    expect(resolveAgentForegroundProcessMock.mock.calls.length).toBe(scansAfterExpiry)

    await readForegroundAt(handle, 60_000)
    expect(resolveAgentForegroundProcessMock.mock.calls.length).toBeGreaterThan(scansAfterExpiry)
  })

  it('never expires an identity a scan keeps recognizing', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: true, processName: 'claude' })
    readConptyMock.mockReturnValue(new Set([12345, 999]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 40_000)).toBe('claude')
    expect(await readForegroundAt(handle, 120_000)).toBe('claude')
  })

  it('never expires an identity while scans stay degraded', async () => {
    // Expiration requires an available scan that found no agent.
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: false, processName: null })
    readConptyMock.mockReturnValue(new Set([12345, 999]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 120_000)).toBe('claude')
  })

  it('never expires an identity while the job answer is unverifiable', async () => {
    // Loss of contact is not proof of death.
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockReturnValue(null)
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 120_000)).toBe('claude')
  })

  it('retires an anchored agent immediately when its pid leaves the job, despite a leftover', async () => {
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({
        available: true,
        processName: 'claude',
        processId: 999
      })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockReturnValue(new Set([12345, 999]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    // Agent 999 exits while detached member 777 keeps the job larger than the shell.
    readConptyMock.mockReturnValue(new Set([12345, 777]))
    await readForegroundAt(handle, 1_000)
    expect(await readForegroundAt(handle, 1_100)).toBe('powershell.exe')
  })

  it('never retires an anchored agent the job still holds, even when scans miss it', async () => {
    // An anchored job member keeps its identity despite incomplete process-table rows.
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({
        available: true,
        processName: 'claude',
        processId: 999
      })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockReturnValue(new Set([12345, 999]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    await readForegroundAt(handle, 40_000)
    expect(await readForegroundAt(handle, 40_100)).toBe('claude')
    expect(await readForegroundAt(handle, 120_000)).toBe('claude')
  })

  it('retires an anchored agent when the scan proves its pid was recycled', async () => {
    // A foreign process identity overrides continued membership of a recycled PID.
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude', processId: 999 })
      .mockResolvedValue({ available: true, processName: null, anchorPidForeign: true })
    readConptyMock.mockReturnValue(new Set([12345, 999]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    await readForegroundAt(handle, 1_000)
    expect(await readForegroundAt(handle, 1_100)).toBe('powershell.exe')
  })

  it('retires on a shipped build whose node-pty cannot answer job queries', async () => {
    // Without job-query support, an available process scan must decide retirement.
    jobReadableMock.mockReturnValue(false)
    readConptyMock.mockReturnValue(null)
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    await readForegroundAt(handle, 1_000)
    expect(await readForegroundAt(handle, 1_100)).toBe('powershell.exe')
  })

  it('retires a cached agent when a scan finds no agent and the console is shell-only', async () => {
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockReturnValue(new Set([12345]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    await readForegroundAt(handle, 1_000)
    expect(await readForegroundAt(handle, 1_100)).toBe('powershell.exe')
    expect(readConptyMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a cached agent when the console-membership probe is unavailable', async () => {
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockReturnValue(null)
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 1_000)).toBe('claude')
    expect(await readForegroundAt(handle, 2_500)).toBe('claude')
    expect(readConptyMock).toHaveBeenCalledTimes(2)
  })
})
