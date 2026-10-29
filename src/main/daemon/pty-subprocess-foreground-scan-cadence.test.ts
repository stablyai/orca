import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type * as LocalPtyUtils from '../providers/local-pty-utils'
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

// Keep PowerShell resolution deterministic on non-Windows hosts.
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

vi.mock('../providers/local-pty-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalPtyUtils>()
  return {
    ...actual,
    getNodePtySpawnHelperCandidates: () => [import.meta.filename]
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

import { createPtySubprocess } from './pty-subprocess'
import { createConptyPreludeSender } from './pty-subprocess-test-harness'

// Well past any hot window or retry throttle so t=0 reads behave as idle.
const BASE_TIME_MS = 1_000_000

function mockPtyProcess(processName: string, pid = 12345) {
  const onDataListeners: ((data: string) => void)[] = []
  const sendConptyPrelude = createConptyPreludeSender()
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: processName,
    onData: vi.fn((cb: (data: string) => void) => {
      onDataListeners.push(cb)
      sendConptyPrelude(cb)
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

// Settle each scheduled refresh before advancing the clock for the next reader poll.
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

  async function spawnShellSubprocess(
    shellProcessName: string,
    targetPlatform: 'win32' | 'darwin'
  ) {
    Object.defineProperty(process, 'platform', { configurable: true, value: targetPlatform })
    const proc = mockPtyProcess(shellProcessName)
    spawnMock.mockReturnValue(proc)
    // Startup output (ConPTY DA1 query) lands before the 10s hot window these idle cases measure.
    vi.setSystemTime(BASE_TIME_MS - 11_000)
    const handle = await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    vi.setSystemTime(BASE_TIME_MS)
    return { proc, handle }
  }

  it('bounds scans for an idle Windows shell polled every 2s to the 15s retry tier', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue('powershell.exe')
    const { handle } = await spawnShellSubprocess('powershell.exe', 'win32')

    for (let atMs = 0; atMs <= 60_000; atMs += 2_000) {
      expect(await readForegroundAt(handle, atMs)).toBe('powershell.exe')
    }

    // The 15s retry tier yields scans at 0s, 16s, 32s, and 48s under 2s polling.
    expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(4)
  })

  it('re-arms the fast retry when PTY output appears on an idle Windows shell', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValueOnce('powershell.exe')
    const { proc, handle } = await spawnShellSubprocess('powershell.exe', 'win32')

    await readForegroundAt(handle, 0)
    await readForegroundAt(handle, 2_000)
    await readForegroundAt(handle, 4_000)
    await readForegroundAt(handle, 6_000)
    expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(1)

    resolveAgentForegroundProcessMock.mockResolvedValue('claude')
    vi.setSystemTime(BASE_TIME_MS + 6_500)
    proc._simulateData('claude\r\n')

    await readForegroundAt(handle, 8_000)
    expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
    expect(await readForegroundAt(handle, 8_500)).toBe('claude')
  })

  it('keeps the fast identity refresh for a Windows session with a cached agent', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue('codex')
    const { handle } = await spawnShellSubprocess('powershell.exe', 'win32')

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 1_000)).toBe('codex')
    await readForegroundAt(handle, 3_000)
    await readForegroundAt(handle, 5_000)

    // Cached identity keeps the 1s refresh tier even without recent output.
    expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(4)
  })

  it('keeps the 5s retry for an idle POSIX shell with no output', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue('zsh')
    const { handle } = await spawnShellSubprocess('zsh', 'darwin')

    for (let atMs = 0; atMs <= 30_000; atMs += 2_000) {
      expect(await readForegroundAt(handle, atMs)).toBe('zsh')
    }

    // The 5s tier yields scans at 0s, 6s, 12s, 18s, 24s, and 30s under 2s polling.
    expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(6)
  })

  it.each(['darwin', 'win32'] as const)(
    'keeps wrapped pi reads on the cached omp owner between bounded %s scans',
    async (targetPlatform) => {
      resolveAgentForegroundProcessMock.mockResolvedValue('omp')
      const { handle } = await spawnShellSubprocess('pi', targetPlatform)

      const reads: (string | null)[] = []
      for (let atMs = 0; atMs <= 3_000; atMs += 250) {
        reads.push(await readForegroundAt(handle, atMs))
      }

      // Serve the enriched owner across cache expiry while its next scan is in flight.
      expect(reads).toEqual(['pi', ...Array.from({ length: 12 }, () => 'omp')])
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(4)

      await expect(handle.confirmForegroundProcess!()).resolves.toBe('omp')
      expect(resolveAgentForegroundProcessMock).toHaveBeenLastCalledWith(
        12345,
        'pi',
        expect.objectContaining({ fresh: true })
      )
    }
  )

  it.each(['darwin', 'win32'] as const)(
    'keeps authoritative %s omp reads on the zero-scan path',
    async (targetPlatform) => {
      const { handle } = await spawnShellSubprocess('omp', targetPlatform)

      for (let atMs = 0; atMs <= 3_000; atMs += 250) {
        expect(await readForegroundAt(handle, atMs)).toBe('omp')
      }
      expect(resolveAgentForegroundProcessMock).not.toHaveBeenCalled()
    }
  )

  it.each(['darwin', 'win32'] as const)(
    'keeps the cached omp owner when a %s wrapper scan is unavailable',
    async (targetPlatform) => {
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce('omp')
        .mockResolvedValue({ available: false, processName: 'pi' })
      const { handle } = await spawnShellSubprocess('pi', targetPlatform)

      expect(await readForegroundAt(handle, 0)).toBe('pi')
      expect(await readForegroundAt(handle, 1_000)).toBe('omp')
      expect(await readForegroundAt(handle, 2_500)).toBe('omp')
    }
  )
})
