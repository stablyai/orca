import { afterEach, describe, expect, it, vi } from 'vitest'

const { loadWindowsSecurity, setIsolatedSpawner } = vi.hoisted(() => ({
  loadWindowsSecurity: vi.fn(),
  setIsolatedSpawner: vi.fn()
}))
vi.mock('../../shared/windows-security-addon', () => ({ loadWindowsSecurity }))
vi.mock('@orca/process-host/isolated-detached-spawn', () => ({ setIsolatedSpawner }))

import { installWindowsIsolatedSpawner } from './windows-isolated-spawner'

function addonWith(hasNativeExport: (name: string) => boolean) {
  const spawnDetachedIsolated = vi.fn()
  return {
    spawnDetachedIsolated,
    security: { userSid: 'S-1-5-18', addon: { hasNativeExport, spawnDetachedIsolated } }
  }
}

describe('installWindowsIsolatedSpawner', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    loadWindowsSecurity.mockReset()
    setIsolatedSpawner.mockReset()
  })

  it('is a no-op off Windows', () => {
    installWindowsIsolatedSpawner('darwin')

    expect(loadWindowsSecurity).not.toHaveBeenCalled()
    expect(setIsolatedSpawner).not.toHaveBeenCalled()
  })

  it('installs the native spawner when the binary exports it', () => {
    const { security, spawnDetachedIsolated } = addonWith(
      (name) => name === 'spawnDetachedIsolated'
    )
    loadWindowsSecurity.mockReturnValue(security)

    installWindowsIsolatedSpawner('win32')

    expect(setIsolatedSpawner).toHaveBeenCalledWith(spawnDetachedIsolated)
  })

  it('keeps libuv and logs when the binary is stale', () => {
    loadWindowsSecurity.mockReturnValue(addonWith(() => false).security)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    installWindowsIsolatedSpawner('win32')

    expect(setIsolatedSpawner).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[startup] detached spawns inherit handles; the addon build is stale'
    )
  })

  it('keeps libuv and logs when the addon is unavailable or throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadWindowsSecurity.mockReturnValueOnce({ error: 'missing binary' })
    loadWindowsSecurity.mockImplementationOnce(() => {
      throw new Error('boom')
    })

    expect(() => installWindowsIsolatedSpawner('win32')).not.toThrow()
    expect(() => installWindowsIsolatedSpawner('win32')).not.toThrow()
    expect(setIsolatedSpawner).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
