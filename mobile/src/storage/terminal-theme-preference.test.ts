import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn() }
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('mobile terminal theme preference', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(AsyncStorage.getItem).mockReset().mockResolvedValue(null)
    vi.mocked(AsyncStorage.setItem).mockReset().mockResolvedValue(undefined)
  })

  it('defaults to the phone system appearance without writing a preference', async () => {
    const preference = await import('./terminal-theme-preference')
    expect(preference.getMobileTerminalThemeMode()).toBe('system')
    expect(await preference.loadMobileTerminalThemeMode()).toBe('system')
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('orca:terminalThemeMode')
    expect(AsyncStorage.setItem).not.toHaveBeenCalled()
  })

  it('shares hydration and only notifies subscribers when the mode changes', async () => {
    const stored = deferred<string | null>()
    vi.mocked(AsyncStorage.getItem).mockReturnValue(stored.promise)
    const preference = await import('./terminal-theme-preference')
    const listener = vi.fn()
    const unsubscribe = preference.subscribeMobileTerminalThemeMode(listener)
    const first = preference.loadMobileTerminalThemeMode()
    const second = preference.loadMobileTerminalThemeMode()
    expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1)
    stored.resolve('desktop')
    expect(await first).toBe('desktop')
    expect(await second).toBe('desktop')
    expect(listener).toHaveBeenCalledTimes(1)
    await preference.saveMobileTerminalThemeMode('desktop')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    await preference.saveMobileTerminalThemeMode('dark')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps a user choice when an older hydration resolves after the save', async () => {
    const stored = deferred<string | null>()
    vi.mocked(AsyncStorage.getItem).mockReturnValue(stored.promise)
    const preference = await import('./terminal-theme-preference')
    const load = preference.loadMobileTerminalThemeMode()
    await preference.saveMobileTerminalThemeMode('dark')
    stored.resolve('light')
    expect(await load).toBe('dark')
    expect(preference.getMobileTerminalThemeMode()).toBe('dark')
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('orca:terminalThemeMode', 'dark')
  })

  it('serializes writes while publishing the latest choice immediately', async () => {
    const firstWrite = deferred<void>()
    vi.mocked(AsyncStorage.setItem).mockReturnValueOnce(firstWrite.promise)
    const preference = await import('./terminal-theme-preference')
    const first = preference.saveMobileTerminalThemeMode('dark')
    const second = preference.saveMobileTerminalThemeMode('light')
    expect(preference.getMobileTerminalThemeMode()).toBe('light')
    await Promise.resolve()
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1)
    firstWrite.resolve()
    await Promise.all([first, second])
    expect(vi.mocked(AsyncStorage.setItem).mock.calls).toEqual([
      ['orca:terminalThemeMode', 'dark'],
      ['orca:terminalThemeMode', 'light']
    ])
  })

  it('reports a failed write and still persists the newer choice', async () => {
    const firstWrite = deferred<void>()
    vi.mocked(AsyncStorage.setItem).mockReturnValueOnce(firstWrite.promise)
    const preference = await import('./terminal-theme-preference')
    const first = preference.saveMobileTerminalThemeMode('dark')
    const second = preference.saveMobileTerminalThemeMode('light')
    const failed = expect(first).rejects.toThrow('disk unavailable')
    firstWrite.reject(new Error('disk unavailable'))
    await failed
    await second
    expect(preference.getMobileTerminalThemeMode()).toBe('light')
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith('orca:terminalThemeMode', 'light')
  })

  it('keeps the selected appearance visible when its persistence fails', async () => {
    vi.mocked(AsyncStorage.setItem).mockRejectedValue(new Error('storage unavailable'))
    const preference = await import('./terminal-theme-preference')
    await expect(preference.saveMobileTerminalThemeMode('dark')).rejects.toThrow(
      'storage unavailable'
    )
    expect(preference.getMobileTerminalThemeMode()).toBe('dark')
  })

  it('reports read failures and allows the next hydration to retry', async () => {
    vi.mocked(AsyncStorage.getItem)
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce('light')
    const preference = await import('./terminal-theme-preference')
    await expect(preference.loadMobileTerminalThemeMode()).rejects.toThrow('storage unavailable')
    expect(preference.getMobileTerminalThemeMode()).toBe('system')
    expect(await preference.loadMobileTerminalThemeMode()).toBe('light')
  })

  it('reports an invalid stored mode without applying it', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('sepia')
    const preference = await import('./terminal-theme-preference')
    await expect(preference.loadMobileTerminalThemeMode()).rejects.toThrow('terminal theme mode')
    expect(preference.getMobileTerminalThemeMode()).toBe('system')
  })
})
