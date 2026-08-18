import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock
}))

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
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
  })

  it('returns false on non-Windows platforms', async () => {
    const restorePlatform = setPlatform('linux')

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(false)
      expect(execFileSyncMock).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  it('returns true when pwsh.exe is available on Windows', async () => {
    const restorePlatform = setPlatform('win32')
    execFileSyncMock.mockReturnValue('PowerShell 7.5.0')

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(true)
      expect(execFileSyncMock).toHaveBeenCalledWith('pwsh.exe', ['-Version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000
      })
    } finally {
      restorePlatform()
    }
  })

  it('returns false when pwsh.exe probe throws on Windows', async () => {
    const restorePlatform = setPlatform('win32')
    execFileSyncMock.mockImplementation(() => {
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
    execFileSyncMock.mockReturnValue('PowerShell 7.5.0')

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(true)
      expect(isPwshAvailable()).toBe(true)
      expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    } finally {
      restorePlatform()
    }
  })

  it('repro: does not keep a cold-start timeout cached for the daemon lifetime', async () => {
    const restorePlatform = setPlatform('win32')
    execFileSyncMock
      .mockImplementationOnce(() => {
        const error = Object.assign(new Error('spawnSync pwsh.exe ETIMEDOUT'), {
          code: 'ETIMEDOUT'
        })
        throw error
      })
      .mockReturnValue('PowerShell 7.5.0')

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(false)
      expect(isPwshAvailable()).toBe(true)
      expect(execFileSyncMock).toHaveBeenCalledTimes(2)
    } finally {
      restorePlatform()
    }
  })

  it('warms pwsh availability asynchronously with a longer timeout', async () => {
    const restorePlatform = setPlatform('win32')
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, 'PowerShell 7.5.0', '')
    })

    try {
      const { isPwshAvailable, warmPwshAvailabilityCache } = await import('./pwsh')
      await expect(warmPwshAvailabilityCache()).resolves.toBe(true)
      expect(execFileMock).toHaveBeenCalledWith(
        'pwsh.exe',
        ['-Version'],
        { timeout: 30_000, windowsHide: true },
        expect.any(Function)
      )
      expect(isPwshAvailable()).toBe(true)
      expect(execFileSyncMock).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  // Why: the renderer's Windows capability read reaches this over IPC, and the sync probe
  // blocks the Electron main thread for the full timeout when pwsh.exe cold-starts.
  it('answers IPC callers without blocking the main thread', async () => {
    const restorePlatform = setPlatform('win32')
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      setTimeout(() => callback(null, 'PowerShell 7.5.0', ''), 0)
    })

    try {
      const { isPwshAvailableAsync } = await import('./pwsh')
      const results = await Promise.all([isPwshAvailableAsync(), isPwshAvailableAsync()])
      expect(results).toEqual([true, true])
      // Concurrent readers share one spawn.
      expect(execFileMock).toHaveBeenCalledTimes(1)
      expect(execFileMock).toHaveBeenCalledWith(
        'pwsh.exe',
        ['-Version'],
        { timeout: 5000, windowsHide: true },
        expect.any(Function)
      )
      expect(execFileSyncMock).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  it('reuses the negative cache for async callers so a missing pwsh is not re-spawned', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const restorePlatform = setPlatform('win32')
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error('missing pwsh'), '', '')
    })

    try {
      const { isPwshAvailableAsync } = await import('./pwsh')
      await expect(isPwshAvailableAsync()).resolves.toBe(false)
      await expect(isPwshAvailableAsync()).resolves.toBe(false)
      expect(execFileMock).toHaveBeenCalledTimes(1)
    } finally {
      restorePlatform()
      vi.useRealTimers()
    }
  })

  it('does not let an older async failure overwrite a newer warmup success', async () => {
    const restorePlatform = setPlatform('win32')
    let finishAsyncProbe!: (error: Error | null) => void
    let finishWarmup!: (error: Error | null) => void
    execFileMock.mockImplementation((_file, _args, options, callback) => {
      const finish = (error: Error | null): void => callback(error, '', '')
      if (options.timeout === 30_000) {
        finishWarmup = finish
      } else {
        finishAsyncProbe = finish
      }
    })

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
      expect(execFileSyncMock).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  it('does not duplicate an in-flight async probe for a synchronous caller', async () => {
    const restorePlatform = setPlatform('win32')
    let finishAsyncProbe!: (error: Error | null) => void
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      finishAsyncProbe = (error) => callback(error, '', '')
    })

    try {
      const { isPwshAvailable, isPwshAvailableAsync } = await import('./pwsh')
      const probe = isPwshAvailableAsync()

      expect(isPwshAvailable()).toBe(true)
      expect(execFileSyncMock).not.toHaveBeenCalled()

      finishAsyncProbe(null)
      await expect(probe).resolves.toBe(true)
    } finally {
      restorePlatform()
    }
  })

  // Why: execFile reports a timeout as a SIGTERM kill, not ETIMEDOUT, so caching it as a
  // failure would disable the user's PowerShell 7 preference for 30s on every slow cold start.
  it('does not cache a cold-start timeout from the async probe', async () => {
    const restorePlatform = setPlatform('win32')
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(Object.assign(new Error('pwsh.exe timed out'), { killed: true, signal: 'SIGTERM' }))
    })
    execFileSyncMock.mockReturnValue('PowerShell 7.5.0')

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
    execFileSyncMock
      .mockImplementationOnce(() => {
        throw new Error('missing pwsh')
      })
      .mockReturnValue('PowerShell 7.5.0')

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(false)
      expect(isPwshAvailable()).toBe(false)
      vi.setSystemTime(31_001)
      expect(isPwshAvailable()).toBe(true)
      expect(execFileSyncMock).toHaveBeenCalledTimes(2)
    } finally {
      restorePlatform()
      vi.useRealTimers()
    }
  })
})
