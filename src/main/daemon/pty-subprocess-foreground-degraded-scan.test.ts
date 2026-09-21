// Guards the daemon foreground identity against Windows scan degradation: a
// timed-out CIM scan (available:false) or an incomplete snapshot (available:true
// with the agent row missing) must not retire a still-working agent and make
// the coordinator read the shell as a false "agent done". Console presence is
// the arbiter of a real exit.
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

  it('keeps a cached agent across a degraded (timed-out) scan', async () => {
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: false, processName: null })
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0) // establishes 'claude'
    expect(await readForegroundAt(handle, 1_000)).toBe('claude') // refresh returns degraded → keep
    // Past the 1s TTL with a shell fallback: pre-fix this returned the shell.
    expect(await readForegroundAt(handle, 2_500)).toBe('claude')
    expect(readConptyMock).not.toHaveBeenCalled()
  })

  it('keeps a cached agent, for a bounded time, when the job still has a descendant', async () => {
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockReturnValue(new Set([12345, 999])) // child still attached
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 1_000)).toBe('claude')
    expect(await readForegroundAt(handle, 2_500)).toBe('claude')
  })

  it('stops holding a dead agent once the job answer is only a superset', async () => {
    // The WSL shape: job [shell, detached plumbing] forever, so `size > 1` used
    // to veto retirement outright and pin an exited agent's name for the life of
    // the pane. Job membership is a SUPERSET of the console -- it cannot tell a
    // working agent from a leftover -- so age decides instead.
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockReturnValue(new Set([12345, 999]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 2_500)).toBe('claude')
    await readForegroundAt(handle, 40_000) // this refresh clears the cache
    expect(await readForegroundAt(handle, 40_100)).toBe('powershell.exe')
  })

  it('restores the idle refresh backoff once the dead identity is gone', async () => {
    // A non-null cache makes idleNoEvidenceShell false, which pins retryMs at
    // the 1s TTL. Never clearing the cache therefore also meant scanning the
    // process table every second, forever, on an idle pane.
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockReturnValue(new Set([12345, 999]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    await readForegroundAt(handle, 40_000) // identity expires here
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
    // Age must only advance on positive "I looked and found no agent" evidence.
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: false, processName: null })
    readConptyMock.mockReturnValue(new Set([12345, 999]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 120_000)).toBe('claude')
  })

  it('never expires an identity while the job answer is unverifiable', async () => {
    // ssh-execution-boundary.md: loss of contact is not evidence of death.
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockReturnValue(null)
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 120_000)).toBe('claude')
  })

  it('retires an anchored agent immediately when its pid leaves the job, despite a leftover', async () => {
    // With an anchor pid the detached-leftover shape no longer pins a dead
    // agent for the age bound: the anchor missing from a complete job read is
    // proof of exit, leftovers notwithstanding.
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
    // Agent 999 exits; detached plumbing 777 keeps the job larger than the shell.
    readConptyMock.mockReturnValue(new Set([12345, 777]))
    await readForegroundAt(handle, 1_000) // refresh sees the anchor gone and clears
    expect(await readForegroundAt(handle, 1_100)).toBe('powershell.exe')
  })

  it('never retires an anchored agent the job still holds, even when scans miss it', async () => {
    // The anchor pid alive in the job is proof of life: agentless-but-available
    // scans past the age bound restamp instead of retiring a working agent.
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
    await readForegroundAt(handle, 40_000) // pre-fix: this refresh cleared the cache
    expect(await readForegroundAt(handle, 40_100)).toBe('claude')
    expect(await readForegroundAt(handle, 120_000)).toBe('claude')
  })

  it('retires an anchored agent when the scan proves its pid was recycled', async () => {
    // Squatter reuse: the pid survives in the job, but the scan shows it now
    // runs a non-agent. Proof of life must yield to proof of a different process.
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude', processId: 999 })
      .mockResolvedValue({ available: true, processName: null, anchorPidForeign: true })
    readConptyMock.mockReturnValue(new Set([12345, 999]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    await readForegroundAt(handle, 1_000) // refresh sees the foreign anchor and clears
    expect(await readForegroundAt(handle, 1_100)).toBe('powershell.exe')
  })

  it('retires on a shipped build whose node-pty cannot answer job queries', async () => {
    // The real Windows fleet today: no job exports (#16059), so the read is null
    // for every user. Treating that as unverifiable held a dead agent forever.
    // With nothing to ask, the available scan that already found no agent decides.
    jobReadableMock.mockReturnValue(false)
    readConptyMock.mockReturnValue(null)
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    await readForegroundAt(handle, 1_000) // this refresh retires it
    expect(await readForegroundAt(handle, 1_100)).toBe('powershell.exe')
  })

  it('retires a cached agent when a scan finds no agent and the console is shell-only', async () => {
    resolveAgentForegroundProcessMock
      .mockResolvedValueOnce({ available: true, processName: 'claude' })
      .mockResolvedValue({ available: true, processName: null })
    readConptyMock.mockReturnValue(new Set([12345]))
    const { handle } = await spawnWindowsShell()

    await readForegroundAt(handle, 0)
    await readForegroundAt(handle, 1_000) // refresh clears the cache
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
