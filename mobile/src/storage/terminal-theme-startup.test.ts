import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadMobileTerminalThemeMode } from './terminal-theme-preference'
import { startMobileTerminalAppearance } from './terminal-theme-startup'

vi.mock('./terminal-theme-preference', () => ({ loadMobileTerminalThemeMode: vi.fn() }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('terminal appearance startup', () => {
  it('waits for saved appearance before declaring startup ready', async () => {
    let resolveLoad!: (mode: 'light') => void
    vi.mocked(loadMobileTerminalThemeMode).mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve
      })
    )
    const done = vi.fn()
    const ready = startMobileTerminalAppearance().then(done)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    resolveLoad('light')
    await ready
    expect(done).toHaveBeenCalledOnce()
  })

  it('reports a storage failure and allows startup to finish', async () => {
    const error = new Error('storage unavailable')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(loadMobileTerminalThemeMode).mockRejectedValue(error)
    await startMobileTerminalAppearance()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminal appearance'), error)
  })

  it('allows startup to finish when the saved appearance never loads', async () => {
    vi.useFakeTimers()
    vi.mocked(loadMobileTerminalThemeMode).mockReturnValue(new Promise(() => undefined))
    const ready = startMobileTerminalAppearance()
    await vi.advanceTimersByTimeAsync(2000)
    await ready
    expect(vi.getTimerCount()).toBe(0)
  })
})
