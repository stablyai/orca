import 'node:fs'
import 'node:os'
import 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

function exited(stdout: string, code: number | null = 0): ProcessResult {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

const FAILED = exited('', 1)

import {
  _resetWslCachesForTests,
  _setWslCachesForTests,
  listRunningWslDistrosAsync
} from './distro-catalog'
import { filterPathsToRunningWslDistrosAsync } from '../filesystem/wsl-running-path-filter'
import '../execution/wsl-interop-spawn-directory'
import { resetWslTranscriptRunningObserverForTests } from '../../native-chat/transcript-filesystem/wsl-transcript-running-observer'

async function withPlatform<T>(value: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('running WSL distro discovery', () => {
  // A healthy host whose installed list is known, so an empty running list needs no second look.
  beforeEach(() => _setWslCachesForTests({ distros: ['Ubuntu'] }))

  afterEach(() => {
    runProcessMock.mockReset()
    _resetWslCachesForTests()
    resetWslTranscriptRunningObserverForTests()
    vi.useRealTimers()
  })

  it('rejects stale running state for launch admission through failure and backoff', async () => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValueOnce(exited('Ubuntu\n'))

    await withPlatform('win32', async () => {
      await expect(listRunningWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      runProcessMock.mockResolvedValue(FAILED)
      const paths = ['\\\\wsl.localhost\\Ubuntu\\home\\ada']
      await expect(
        filterPathsToRunningWslDistrosAsync(paths, { requireConfirmed: true })
      ).rejects.toThrow('discovery is unavailable')
      await expect(listRunningWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      await expect(listRunningWslDistrosAsync({ requireConfirmed: true })).rejects.toThrow(
        'discovery is unavailable'
      )
      expect(runProcessMock).toHaveBeenCalledTimes(2)

      runProcessMock.mockResolvedValue(exited(''))
      await vi.advanceTimersByTimeAsync(15_001)
      await expect(
        filterPathsToRunningWslDistrosAsync(paths, { requireConfirmed: true })
      ).resolves.toEqual([])
      expect(runProcessMock).toHaveBeenCalledTimes(3)
    })
  })
})
