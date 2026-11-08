import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'
import '@orca/process-host/wsl-distro-allowlist'
import {
  _resetWslCachesForTests,
  getWslHome,
  getWslHomeAsync,
  listWslDistrosAsync
} from './distro-catalog'
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

describe('WSL home probe on a booting distro', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    _resetWslCachesForTests()
  })

  it('never starts a 5 s synchronous probe while the async one waits out a boot', async () => {
    let finish!: (result: ProcessResult) => void
    runProcessMock.mockReturnValueOnce(new Promise<ProcessResult>((resolve) => (finish = resolve)))
    await withPlatformAsync('win32', async () => {
      const pending = getWslHomeAsync('Ubuntu')
      expect(getWslHome('Ubuntu')).toBeNull()
      expect(runProcessSyncMock).not.toHaveBeenCalled()
      finish(exited('/home/alice\n'))
      expect(await pending).toContain('alice')
    })
  })
})

describe('WSL availability cache', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    _resetWslCachesForTests()
  })

  it('does not restore a failure after distro discovery disproves it mid-probe', async () => {
    const callbacks = new Map<string, (result: ProcessResult) => void>()
    runProcessMock.mockImplementation(
      ({ args }: { args: string[] }) =>
        new Promise((resolve) => {
          callbacks.set(args.join(' '), resolve)
        })
    )

    await withPlatformAsync('win32', async () => {
      const staleAvailability = isWslAvailableAsync()
      const distroProbe = listWslDistrosAsync()
      callbacks.get('--list --quiet')?.(exited('Ubuntu\n'))
      await expect(distroProbe).resolves.toEqual(['Ubuntu'])

      callbacks.get('--status')?.(exited('', 1))
      await expect(staleAvailability).resolves.toBe(false)
      expect(getCachedWslAvailability()).toBeNull()

      const retry = isWslAvailableAsync()
      callbacks.get('--status')?.(exited(''))
      await expect(retry).resolves.toBe(true)
    })
  })
})
