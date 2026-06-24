import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileSyncMock, execFileMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
  execFile: execFileMock
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
    execFileSyncMock.mockReset()
    execFileMock.mockReset()
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

  it('re-probes after a negative result so a one-off failure does not poison the session', async () => {
    const restorePlatform = setPlatform('win32')
    const nowSpy = vi.spyOn(Date, 'now')

    try {
      // First probe fails (e.g. timed out during a busy startup).
      nowSpy.mockReturnValue(0)
      execFileSyncMock.mockImplementationOnce(() => {
        throw new Error('timed out')
      })

      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(false)

      // Within the negative TTL, the cached false is reused without re-spawning.
      nowSpy.mockReturnValue(5_000)
      expect(isPwshAvailable()).toBe(false)
      expect(execFileSyncMock).toHaveBeenCalledTimes(1)

      // After the TTL, a recovered machine re-probes and reports pwsh available.
      nowSpy.mockReturnValue(40_000)
      execFileSyncMock.mockReturnValue('PowerShell 7.5.0')
      expect(isPwshAvailable()).toBe(true)
      expect(execFileSyncMock).toHaveBeenCalledTimes(2)

      // A positive result is cached for good.
      expect(isPwshAvailable()).toBe(true)
      expect(execFileSyncMock).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
      restorePlatform()
    }
  })
})

describe('warmPwshAvailability', () => {
  beforeEach(() => {
    vi.resetModules()
    execFileSyncMock.mockReset()
    execFileMock.mockReset()
  })

  it('does nothing on non-Windows platforms', async () => {
    const restorePlatform = setPlatform('linux')

    try {
      const { warmPwshAvailability } = await import('./pwsh')
      warmPwshAvailability()
      expect(execFileMock).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  it('populates the positive cache so isPwshAvailable() needs no sync probe', async () => {
    const restorePlatform = setPlatform('win32')
    // Async probe succeeds: invoke the callback with no error.
    execFileMock.mockImplementation((_file, _args, _opts, cb) => {
      cb(null, 'PowerShell 7.5.0', '')
    })

    try {
      const { warmPwshAvailability, isPwshAvailable } = await import('./pwsh')
      warmPwshAvailability()
      expect(isPwshAvailable()).toBe(true)
      // The warm result short-circuits the synchronous probe entirely.
      expect(execFileSyncMock).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  it('leaves the cache untouched when the warm probe fails so the TTL path still runs', async () => {
    const restorePlatform = setPlatform('win32')
    // Warm probe fails (e.g. cold-start timeout)…
    execFileMock.mockImplementation((_file, _args, _opts, cb) => {
      cb(new Error('timed out'), '', '')
    })
    // …but a later synchronous probe recovers.
    execFileSyncMock.mockReturnValue('PowerShell 7.5.0')

    try {
      const { warmPwshAvailability, isPwshAvailable } = await import('./pwsh')
      warmPwshAvailability()
      expect(isPwshAvailable()).toBe(true)
      expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    } finally {
      restorePlatform()
    }
  })
})
