import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import {
  _resetWslCachesForTests,
  listRunningWslDistrosAsync,
  listWslDistros,
  listWslDistrosAsync
} from './distro-catalog'
import { isWslAvailableAsync } from './wsl-availability'

const { runProcessMock, runProcessSyncMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  runProcessSyncMock: vi.fn()
}))

vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
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
})
