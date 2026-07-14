import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock, resolvePwshPathsMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  resolvePwshPathsMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock
}))

vi.mock('./providers/windows-powershell-executable', () => ({
  cacheWindowsPwshSupport: vi.fn(),
  resolveWindowsPwshExecutablePaths: resolvePwshPathsMock
}))

const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

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
    resolvePwshPathsMock.mockReset()
    resolvePwshPathsMock.mockReturnValue([PWSH7])
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
      expect(execFileSyncMock).toHaveBeenCalledWith(PWSH7, ['-Version'], {
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

  it('returns false when only PowerShell 6 is installed', async () => {
    const restorePlatform = setPlatform('win32')
    execFileSyncMock.mockReturnValue('PowerShell 6.2.7')

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(false)
    } finally {
      restorePlatform()
    }
  })

  it('returns false when pwsh is only an App Execution Alias', async () => {
    const restorePlatform = setPlatform('win32')
    resolvePwshPathsMock.mockReturnValue([])

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(false)
      expect(execFileSyncMock).not.toHaveBeenCalled()
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
        PWSH7,
        ['-Version'],
        { timeout: 30_000 },
        expect.any(Function)
      )
      expect(isPwshAvailable()).toBe(true)
      expect(execFileSyncMock).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  it('asynchronously skips legacy PowerShell and caches the next PowerShell 7+ path', async () => {
    const restorePlatform = setPlatform('win32')
    const pwsh6 = 'D:\\Tools\\PowerShell\\6\\pwsh.exe'
    resolvePwshPathsMock.mockReturnValue([pwsh6, PWSH7])
    execFileMock
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, 'PowerShell 6.2.7', '')
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, 'PowerShell 7.5.0', '')
      })

    try {
      const { resolveAvailablePwshPath, warmPwshAvailabilityCache } = await import('./pwsh')
      await expect(warmPwshAvailabilityCache()).resolves.toBe(true)
      expect(resolveAvailablePwshPath()).toBe(PWSH7)
      expect(execFileMock).toHaveBeenCalledTimes(2)
      expect(execFileSyncMock).not.toHaveBeenCalled()
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
