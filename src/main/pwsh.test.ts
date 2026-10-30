import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock, runProcessSyncMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  runProcessSyncMock: vi.fn()
}))

// Process-host normalizes timeout outcomes; test availability policy independently of spawning.
vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))

const ok = { code: 0, signal: null, stdout: '7.4.0', stderr: '', timedOut: false }
const missing = { code: 1, signal: null, stdout: '', stderr: 'not found', timedOut: false }
const timedOut = { code: null, signal: 'SIGTERM' as const, stdout: '', stderr: '', timedOut: true }

function setPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })

  return () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  }
}

describe('isPwshAvailable', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useRealTimers()
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
  })

  it('returns false on non-Windows platforms', async () => {
    const restorePlatform = setPlatform('linux')

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(false)
      expect(runProcessSyncMock).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  it('returns true when pwsh.exe is available on Windows', async () => {
    const restorePlatform = setPlatform('win32')
    runProcessSyncMock.mockReturnValue(ok)

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(true)
      expect(runProcessSyncMock).toHaveBeenCalledWith({
        program: 'pwsh.exe',
        args: ['-Version'],
        timeoutMs: 5000
      })
    } finally {
      restorePlatform()
    }
  })

  it('returns false when pwsh.exe probe throws on Windows', async () => {
    const restorePlatform = setPlatform('win32')
    runProcessSyncMock.mockImplementation(() => {
      throw new Error('missing pwsh')
    })

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(false)
    } finally {
      restorePlatform()
    }
  })

  it('reuses the cached result across repeated calls', async () => {
    const restorePlatform = setPlatform('win32')
    runProcessSyncMock.mockReturnValue(ok)

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(true)
      expect(isPwshAvailable()).toBe(true)
      expect(runProcessSyncMock).toHaveBeenCalledTimes(1)
    } finally {
      restorePlatform()
    }
  })

  it('repro: does not keep a cold-start timeout cached for the daemon lifetime', async () => {
    const restorePlatform = setPlatform('win32')
    runProcessSyncMock.mockReturnValueOnce(timedOut).mockReturnValue(ok)

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(false)
      expect(isPwshAvailable()).toBe(true)
      expect(runProcessSyncMock).toHaveBeenCalledTimes(2)
    } finally {
      restorePlatform()
    }
  })

  it('warms pwsh availability asynchronously with a longer timeout', async () => {
    const restorePlatform = setPlatform('win32')
    runProcessMock.mockResolvedValue(ok)

    try {
      const { isPwshAvailable, warmPwshAvailabilityCache } = await import('./pwsh')
      await expect(warmPwshAvailabilityCache()).resolves.toBe(true)
      expect(runProcessMock).toHaveBeenCalledWith({
        program: 'pwsh.exe',
        args: ['-Version'],
        timeoutMs: 30_000
      })
      expect(isPwshAvailable()).toBe(true)
      expect(runProcessSyncMock).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  it('answers IPC callers without blocking the main thread', async () => {
    const restorePlatform = setPlatform('win32')
    runProcessMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(ok), 0))
    )

    try {
      const { isPwshAvailableAsync } = await import('./pwsh')
      const results = await Promise.all([isPwshAvailableAsync(), isPwshAvailableAsync()])
      expect(results).toEqual([true, true])
      expect(runProcessMock).toHaveBeenCalledTimes(1)
      expect(runProcessMock).toHaveBeenCalledWith({
        program: 'pwsh.exe',
        args: ['-Version'],
        timeoutMs: 5000
      })
      expect(runProcessSyncMock).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  it('reuses the negative cache for async callers so a missing pwsh is not re-spawned', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const restorePlatform = setPlatform('win32')
    runProcessMock.mockResolvedValue(missing)

    try {
      const { isPwshAvailableAsync } = await import('./pwsh')
      await expect(isPwshAvailableAsync()).resolves.toBe(false)
      await expect(isPwshAvailableAsync()).resolves.toBe(false)
      expect(runProcessMock).toHaveBeenCalledTimes(1)
    } finally {
      restorePlatform()
      vi.useRealTimers()
    }
  })

  it('does not let an older async failure overwrite a newer warmup success', async () => {
    const restorePlatform = setPlatform('win32')
    let finishAsyncProbe!: (error: Error | null) => void
    let finishWarmup!: (error: Error | null) => void
    runProcessMock.mockImplementation(
      (spec: { timeoutMs: number }) =>
        new Promise((resolve) => {
          const finish = (error: Error | null): void => resolve(error ? missing : ok)
          if (spec.timeoutMs === 30_000) {
            finishWarmup = finish
          } else {
            finishAsyncProbe = finish
          }
        })
    )

    try {
      const { isPwshAvailable, isPwshAvailableAsync, warmPwshAvailabilityCache } =
        await import('./pwsh')
      const staleProbe = isPwshAvailableAsync()
      const warmup = warmPwshAvailabilityCache()
      finishWarmup(null)
      await expect(warmup).resolves.toBe(true)

      finishAsyncProbe(new Error('older failure'))

      await expect(staleProbe).resolves.toBe(true)
      expect(isPwshAvailable()).toBe(true)
      expect(runProcessSyncMock).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  it('does not duplicate an in-flight async probe for a synchronous caller', async () => {
    const restorePlatform = setPlatform('win32')
    let finishAsyncProbe!: (error: Error | null) => void
    runProcessMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishAsyncProbe = (error) => resolve(error ? missing : ok)
        })
    )

    try {
      const { isPwshAvailable, isPwshAvailableAsync } = await import('./pwsh')
      const probe = isPwshAvailableAsync()

      expect(isPwshAvailable()).toBe(true)
      expect(runProcessSyncMock).not.toHaveBeenCalled()

      finishAsyncProbe(null)
      await expect(probe).resolves.toBe(true)
    } finally {
      restorePlatform()
    }
  })

  // A slow .NET cold start must not disable the preferred PowerShell for the negative-cache TTL.
  it('does not cache a cold-start timeout from the async probe', async () => {
    const restorePlatform = setPlatform('win32')
    runProcessMock.mockResolvedValue(timedOut)
    runProcessSyncMock.mockReturnValue(ok)

    try {
      const { isPwshAvailable, isPwshAvailableAsync } = await import('./pwsh')
      await expect(isPwshAvailableAsync()).resolves.toBe(false)
      expect(isPwshAvailable()).toBe(true)
    } finally {
      restorePlatform()
    }
  })

  it('retries non-timeout failures after the negative cache TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const restorePlatform = setPlatform('win32')
    runProcessSyncMock.mockReturnValueOnce(missing).mockReturnValue(ok)

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(false)
      expect(isPwshAvailable()).toBe(false)
      vi.setSystemTime(31_001)
      expect(isPwshAvailable()).toBe(true)
      expect(runProcessSyncMock).toHaveBeenCalledTimes(2)
    } finally {
      restorePlatform()
      vi.useRealTimers()
    }
  })
})
