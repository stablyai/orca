import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
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
})
