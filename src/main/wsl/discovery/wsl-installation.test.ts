import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import {
  _resetWslCachesForTests,
  getWslHome,
  listRunningWslDistrosAsync,
  listWslDistros,
  listWslDistrosAsync
} from './distro-catalog'
import { isWslAvailableAsync } from './wsl-availability'
import { peekWslInstallation, readWslInstallation } from './wsl-installation'
import { isWslNotInstalledLatched } from '@orca/process-host/wsl-not-installed-latch'

const { runProcessMock, runProcessSyncMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  runProcessSyncMock: vi.fn()
}))

vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))

// Hermetic on a Windows host with WSL: a real service key would answer before the mocked sc.exe.
vi.mock('../../windows/windows-native-registry', () => ({
  loadWindowsNativeRegistry: () => ({ HK: { CU: 1, LM: 2 }, getRegistryKey: () => null })
}))

vi.mock('../execution/wsl-interop-spawn-directory', () => ({
  resolveWslInteropSpawnCwd: () => 'C:\\Windows'
}))

vi.mock('./wsl-registered-distro-fallback', () => ({
  listedOrRegisteredWslDistros: async (listed: string[]) => listed,
  readRegisteredWslDistrosLater: () => {},
  isWslListOutputLost: () => false,
  resetWslListOutputLost: () => {},
  runningWhenListedNone: async () => []
}))

function exited(stdout: string, code: number | null = 0): ProcessResult {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

function isServiceQuery(spec: ProcessSpec): boolean {
  return spec.program.replaceAll('\\', '/').endsWith('/sc.exe') || spec.program === 'sc.exe'
}

function isWslExe(spec: ProcessSpec): boolean {
  return spec.program.replaceAll('\\', '/').endsWith('/wsl.exe') || spec.program === 'wsl.exe'
}

async function withPlatformAsync<T>(value: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

function withPlatform<T>(value: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('WSL is not installed', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    _resetWslCachesForTests()
    vi.useRealTimers()
  })

  it('does not spawn wsl.exe on a Windows host whose WSL services are missing', async () => {
    vi.useFakeTimers()
    const calls: ProcessSpec[] = []
    runProcessMock.mockImplementation(async (spec: ProcessSpec) => {
      calls.push(spec)
      if (isServiceQuery(spec)) {
        return exited('', 1060)
      }
      return exited('The Windows Subsystem for Linux is not installed.\n', 1)
    })
    runProcessSyncMock.mockImplementation((spec: ProcessSpec) => {
      calls.push(spec)
      if (isServiceQuery(spec)) {
        return exited('', 1060)
      }
      return exited('The Windows Subsystem for Linux is not installed.\n', 1)
    })

    await withPlatformAsync('win32', async () => {
      await expect(listWslDistrosAsync()).resolves.toEqual([])
      await expect(listRunningWslDistrosAsync()).resolves.toEqual([])
      await expect(isWslAvailableAsync()).resolves.toBe(false)
      expect(calls.filter(isWslExe)).toEqual([])

      await vi.advanceTimersByTimeAsync(30 * 60_000)
      await expect(listWslDistrosAsync()).resolves.toEqual([])
      await expect(listRunningWslDistrosAsync()).resolves.toEqual([])
      await expect(isWslAvailableAsync()).resolves.toBe(false)
      expect(withPlatform('win32', () => listWslDistros())).toEqual([])
      expect(calls.filter(isWslExe)).toEqual([])
      expect(calls.filter(isServiceQuery).length).toBeGreaterThan(0)
    })
  })

  it('latches the process-host wsl.exe refusal once both services are missing', async () => {
    runProcessMock.mockResolvedValue(exited('', 1060))
    await withPlatformAsync('win32', async () => {
      await expect(readWslInstallation()).resolves.toBe('absent')
    })
    expect(isWslNotInstalledLatched()).toBe(true)
  })

  it.each([
    ['access denied', exited('', 5)],
    ['a timeout', { ...exited('', null), timedOut: true }],
    ['a signal kill', { ...exited('', null), signal: 'SIGTERM' as const }]
  ])('treats %s from sc.exe as unknown and keeps probing wsl.exe', async (_label, failed) => {
    const calls: ProcessSpec[] = []
    runProcessMock.mockImplementation(async (spec: ProcessSpec) => {
      calls.push(spec)
      return isServiceQuery(spec) ? failed : exited('Ubuntu\n')
    })
    await withPlatformAsync('win32', async () => {
      await expect(readWslInstallation()).resolves.toBe('unknown')
      await expect(listWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
    })
    expect(isWslNotInstalledLatched()).toBe(false)
    expect(calls.filter(isWslExe).length).toBe(1)
  })

  function answerServices(codes: Record<string, number | null>): ProcessSpec[] {
    const calls: ProcessSpec[] = []
    runProcessMock.mockImplementation(async (spec: ProcessSpec) => {
      calls.push(spec)
      const code = codes[spec.args?.[1] ?? '']
      return code === undefined
        ? exited('', 1060)
        : { ...exited('', code), timedOut: code === null }
    })
    return calls
  }

  it.each([
    ['WSLService', { WSLService: 0, LxssManager: 1060 }],
    ['LxssManager', { WSLService: 1060, LxssManager: 0 }]
  ])('reports present when only %s is registered', async (_name, codes) => {
    answerServices(codes)
    await withPlatformAsync('win32', async () => {
      await expect(readWslInstallation()).resolves.toBe('present')
    })
    expect(isWslNotInstalledLatched()).toBe(false)
  })

  it('reports unknown when one service is missing and the other query times out', async () => {
    answerServices({ WSLService: 1060, LxssManager: null })
    await withPlatformAsync('win32', async () => {
      await expect(readWslInstallation()).resolves.toBe('unknown')
    })
    expect(isWslNotInstalledLatched()).toBe(false)
  })

  it('reuses an unknown answer briefly, then asks sc.exe again', async () => {
    vi.useFakeTimers()
    const calls = answerServices({ WSLService: 5, LxssManager: 5 })
    await withPlatformAsync('win32', async () => {
      await expect(readWslInstallation()).resolves.toBe('unknown')
      const first = calls.length
      expect(first).toBeGreaterThan(0)
      await expect(readWslInstallation()).resolves.toBe('unknown')
      expect(calls.length).toBe(first)
      await vi.advanceTimersByTimeAsync(60_001)
      await expect(readWslInstallation()).resolves.toBe('unknown')
      expect(calls.length).toBe(first * 2)
    })
  })

  it('keeps failed running-list reads to one sc.exe pair while sc.exe is denied', async () => {
    const calls: ProcessSpec[] = []
    runProcessMock.mockImplementation(async (spec: ProcessSpec) => {
      calls.push(spec)
      return isServiceQuery(spec) ? exited('', 5) : exited('', 1)
    })
    await withPlatformAsync('win32', async () => {
      for (let read = 0; read < 10; read++) {
        await listRunningWslDistrosAsync().catch(() => [])
      }
    })
    expect(calls.filter(isServiceQuery).length).toBeLessThanOrEqual(2)
    expect(calls.filter(isWslExe).length).toBe(1)
  })

  it('a first sync read on a host without WSL never spawns, sync or async', async () => {
    const calls: ProcessSpec[] = []
    runProcessMock.mockImplementation(async (spec: ProcessSpec) => {
      calls.push(spec)
      return isServiceQuery(spec) ? exited('', 1060) : exited('', 1)
    })
    await withPlatformAsync('win32', async () => {
      expect(listWslDistros()).toEqual([])
      expect(getWslHome('Ubuntu')).toBeNull()
      await vi.waitFor(() => expect(isWslNotInstalledLatched()).toBe(true))
      expect(listWslDistros()).toEqual([])
      expect(getWslHome('Ubuntu')).toBeNull()
    })
    expect(runProcessSyncMock).not.toHaveBeenCalled()
    expect(calls.filter(isWslExe)).toEqual([])
  })

  it('serves an expired unknown to sync readers while it re-checks', async () => {
    vi.useFakeTimers()
    const calls = answerServices({ WSLService: 5, LxssManager: 5 })
    runProcessSyncMock.mockReturnValue(exited('Ubuntu\n'))
    await withPlatformAsync('win32', async () => {
      await readWslInstallation()
      const first = calls.length
      await vi.advanceTimersByTimeAsync(60_001)
      expect(peekWslInstallation()).toBe('unknown')
      expect(calls.length).toBe(first)
      expect(listWslDistros()).toEqual(['Ubuntu'])
      await vi.advanceTimersByTimeAsync(0)
      expect(calls.length).toBe(first * 2)
    })
  })
})
