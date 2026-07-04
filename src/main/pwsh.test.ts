import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  execFileMock,
  execFileSyncMock,
  getWindowsPowerShellResolutionDiagnosticMock,
  resolveWindowsPowerShellExecutablePathMock
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  getWindowsPowerShellResolutionDiagnosticMock: vi.fn(),
  resolveWindowsPowerShellExecutablePathMock: vi.fn()
}))

const PWSH_EXECUTABLE_PATH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock
}))

vi.mock('../shared/windows-powershell-executable', () => ({
  getWindowsPowerShellResolutionDiagnostic: getWindowsPowerShellResolutionDiagnosticMock,
  resolveWindowsPowerShellExecutablePath: resolveWindowsPowerShellExecutablePathMock
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
    getWindowsPowerShellResolutionDiagnosticMock.mockReset()
    resolveWindowsPowerShellExecutablePathMock.mockReset()
    getWindowsPowerShellResolutionDiagnosticMock.mockReturnValue({
      family: 'pwsh.exe',
      resolvedPath: PWSH_EXECUTABLE_PATH,
      candidateCount: 1,
      rejectedAliasCandidates: [],
      searchedPath: true,
      reason: 'resolved'
    })
    resolveWindowsPowerShellExecutablePathMock.mockReturnValue(PWSH_EXECUTABLE_PATH)
  })

  it('returns false on non-Windows platforms', async () => {
    const restorePlatform = setPlatform('linux')

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(false)
      expect(execFileSyncMock).not.toHaveBeenCalled()
      expect(resolveWindowsPowerShellExecutablePathMock).not.toHaveBeenCalled()
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
      expect(resolveWindowsPowerShellExecutablePathMock).toHaveBeenCalledWith('pwsh.exe')
      expect(execFileSyncMock).toHaveBeenCalledWith(PWSH_EXECUTABLE_PATH, ['-Version'], {
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

  it('returns false without probing when no real pwsh executable resolves on Windows', async () => {
    const restorePlatform = setPlatform('win32')
    resolveWindowsPowerShellExecutablePathMock.mockReturnValue(null)

    try {
      const { isPwshAvailable } = await import('./pwsh')
      expect(isPwshAvailable()).toBe(false)
      expect(resolveWindowsPowerShellExecutablePathMock).toHaveBeenCalledWith('pwsh.exe')
      expect(execFileSyncMock).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  it('reports the pwsh resolver diagnostic', async () => {
    const { getPwshAvailabilityDiagnostic } = await import('./pwsh')

    expect(getPwshAvailabilityDiagnostic()).toEqual({
      family: 'pwsh.exe',
      resolvedPath: PWSH_EXECUTABLE_PATH,
      candidateCount: 1,
      rejectedAliasCandidates: [],
      searchedPath: true,
      reason: 'resolved'
    })
    expect(getWindowsPowerShellResolutionDiagnosticMock).toHaveBeenCalledWith('pwsh.exe')
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
        PWSH_EXECUTABLE_PATH,
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

  it('returns false without warming when no real pwsh executable resolves on Windows', async () => {
    const restorePlatform = setPlatform('win32')
    resolveWindowsPowerShellExecutablePathMock.mockReturnValue(null)

    try {
      const { warmPwshAvailabilityCache } = await import('./pwsh')
      await expect(warmPwshAvailabilityCache()).resolves.toBe(false)
      expect(resolveWindowsPowerShellExecutablePathMock).toHaveBeenCalledWith('pwsh.exe')
      expect(execFileMock).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })

  it('does not retry non-timeout failures after the negative cache TTL', async () => {
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
      expect(isPwshAvailable()).toBe(false)
      expect(execFileSyncMock).toHaveBeenCalledTimes(1)
      expect(resolveWindowsPowerShellExecutablePathMock).toHaveBeenCalledTimes(1)
    } finally {
      restorePlatform()
      vi.useRealTimers()
    }
  })

  it('does not re-warm after a non-timeout probe failure', async () => {
    const restorePlatform = setPlatform('win32')
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error('pwsh hard error'), '', '')
    })

    try {
      const { warmPwshAvailabilityCache } = await import('./pwsh')
      await expect(warmPwshAvailabilityCache()).resolves.toBe(false)
      await expect(warmPwshAvailabilityCache()).resolves.toBe(false)
      expect(execFileMock).toHaveBeenCalledTimes(1)
      expect(resolveWindowsPowerShellExecutablePathMock).toHaveBeenCalledTimes(1)
    } finally {
      restorePlatform()
    }
  })
})
