import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'
import '@orca/process-host/wsl-distro-allowlist'
import { _resetWslCachesForTests, listWslDistrosAsync } from './distro-catalog'
import { getCachedWslAvailability, isWslAvailableAsync } from './wsl-availability'

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

// These cases model hosts with no registered distro; the lost-output fallback has its own suite.
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

async function withPlatformAsync<T>(value: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('WSL availability cache', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    _resetWslCachesForTests()
  })

  it('does not restore a failure after distro discovery disproves it mid-probe', async () => {
    const callbacks = new Map<string, (result: ProcessResult) => void>()
    runProcessMock.mockImplementation(({ program, args }: { program?: string; args: string[] }) => {
      // An installed WSL service still uses wsl.exe. Absence is a separate test.
      if (program === 'sc.exe' || program?.endsWith('\\sc.exe') || program?.endsWith('/sc.exe')) {
        return Promise.resolve(exited('SERVICE_NAME: WSLService\n'))
      }
      return new Promise((resolve) => {
        callbacks.set(args.join(' '), resolve)
      })
    })

    await withPlatformAsync('win32', async () => {
      const staleAvailability = isWslAvailableAsync()
      const distroProbe = listWslDistrosAsync()
      await vi.waitFor(() => {
        expect(callbacks.has('--list --quiet')).toBe(true)
        expect(callbacks.has('--status')).toBe(true)
      })
      const resolveList = callbacks.get('--list --quiet')
      const resolveStatus = callbacks.get('--status')
      callbacks.delete('--list --quiet')
      callbacks.delete('--status')
      resolveList?.(exited('Ubuntu\n'))
      await expect(distroProbe).resolves.toEqual(['Ubuntu'])

      resolveStatus?.(exited('', 1))
      await expect(staleAvailability).resolves.toBe(false)
      expect(getCachedWslAvailability()).toBeNull()

      const retry = isWslAvailableAsync()
      await vi.waitFor(() => {
        expect(callbacks.has('--status')).toBe(true)
      })
      callbacks.get('--status')?.(exited(''))
      await expect(retry).resolves.toBe(true)
    })
  })
})
