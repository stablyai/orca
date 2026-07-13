// Regression guard: bound the volume of whole-process-table scans the daemon
// schedules for persisted sessions. On Windows each agent-foreground refresh
// forks a powershell.exe/CIM whole-table scan (the daemon-side analogue of
// #6288), so an idle shell with no agent identity and no recent output must
// retry slowly no matter how often readers poll getForegroundProcess; PTY
// output re-arms the fast retry so agent starts still resolve promptly, and
// sessions with a cached agent identity keep the 1s refresh unrelaxed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { spawnMock, isPwshAvailableMock, resolveAgentForegroundProcessMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  isPwshAvailableMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn()
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('../pwsh', () => ({
  isPwshAvailable: isPwshAvailableMock
}))

// Resolve PowerShell family names to deterministic absolute paths so these
// tests run on non-Windows CI (mirrors pty-subprocess.test.ts).
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
  resolveAgentForegroundProcessWithAvailability: async (...args: unknown[]) => ({
    available: true,
    processName: await resolveAgentForegroundProcessMock(...args)
  })
}))

import { createPtySubprocess } from './pty-subprocess'

// Well past any hot window or retry throttle so t=0 reads behave as idle.
const BASE_TIME_MS = 1_000_000

function mockPtyProcess(processName: string, pid = 12345) {
  const onDataListeners: ((data: string) => void)[] = []
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: processName,
    onData: vi.fn((cb: (data: string) => void) => {
      onDataListeners.push(cb)
      return { dispose: vi.fn() }
    }),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    _simulateData: (data: string) => onDataListeners.forEach((cb) => cb(data))
  }
}

async function flushAsyncTicks(count = 6): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

// One renderer/daemon reader poll: read the foreground and let the scheduled
// background refresh (if any) settle so its cache write lands before the next.
async function readForegroundAt(
  handle: { getForegroundProcess: () => string | null },
  atMs: number
): Promise<string | null> {
  vi.setSystemTime(BASE_TIME_MS + atMs)
  const foreground = handle.getForegroundProcess()
  await flushAsyncTicks()
  return foreground
}

describe('daemon pty foreground scan cadence', () => {
  let platform: PropertyDescriptor | undefined
  let previousUserDataPath: string | undefined
  let userDataPath: string

  beforeEach(() => {
    spawnMock.mockReset()
    isPwshAvailableMock.mockReset()
    isPwshAvailableMock.mockReturnValue(false)
    resolveAgentForegroundProcessMock.mockReset()
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-pty-scan-cadence-test-'))
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

  function spawnShellSubprocess(shellProcessName: string, targetPlatform: 'win32' | 'darwin') {
    Object.defineProperty(process, 'platform', { configurable: true, value: targetPlatform })
    const proc = mockPtyProcess(shellProcessName)
    spawnMock.mockReturnValue(proc)
    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    return { proc, handle }
  }

  it('bounds scans for an idle Windows shell polled every 2s to the 15s retry tier', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue('powershell.exe')
    const { handle } = spawnShellSubprocess('powershell.exe', 'win32')

    for (let atMs = 0; atMs <= 60_000; atMs += 2_000) {
      expect(await readForegroundAt(handle, atMs)).toBe('powershell.exe')
    }

    // Scans at t=0s, 16s, 32s, 48s. Pre-fix (5s retry) the same 31 reads drove
    // 11 whole-table scans; the 2s read cadence itself would drive 31.
    expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(4)
  })

  it('re-arms the fast retry when PTY output appears on an idle Windows shell', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValueOnce('powershell.exe')
    const { proc, handle } = spawnShellSubprocess('powershell.exe', 'win32')

    await readForegroundAt(handle, 0)
    await readForegroundAt(handle, 2_000)
    await readForegroundAt(handle, 4_000)
    await readForegroundAt(handle, 6_000)
    // Idle: only the t=0 scan ran (6s is within the relaxed 15s retry).
    expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(1)

    // The user launches an agent; its startup output re-arms the 5s retry.
    resolveAgentForegroundProcessMock.mockResolvedValue('claude')
    vi.setSystemTime(BASE_TIME_MS + 6_500)
    proc._simulateData('claude\r\n')

    await readForegroundAt(handle, 8_000)
    expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
    // The resolved identity is served from the cache on the next read.
    expect(await readForegroundAt(handle, 8_500)).toBe('claude')
  })

  it('keeps the fast identity refresh for a Windows session with a cached agent', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue('codex')
    const { handle } = spawnShellSubprocess('powershell.exe', 'win32')

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 1_000)).toBe('codex')
    await readForegroundAt(handle, 3_000)
    await readForegroundAt(handle, 5_000)

    // Every read past the 1s cache TTL refreshes (t=0s, 1s, 3s, 5s): agent-exit
    // detection through the identity cache must not be relaxed by the idle tier.
    expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(4)
  })

  it('keeps the 5s retry for an idle POSIX shell with no output', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue('zsh')
    const { handle } = spawnShellSubprocess('zsh', 'darwin')

    for (let atMs = 0; atMs <= 30_000; atMs += 2_000) {
      expect(await readForegroundAt(handle, atMs)).toBe('zsh')
    }

    // Scans at t=0s, 6s, 12s, 18s, 24s, 30s — the cheap `ps` path is unchanged.
    expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(6)
  })
})
