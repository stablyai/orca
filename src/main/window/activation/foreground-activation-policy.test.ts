import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { dock: { hide: vi.fn() }, setActivationPolicy: vi.fn() } }))

const { applyBackgroundActivationPolicy, applyServeDesktopWindowActivationPolicy } =
  await import('./foreground-activation-policy')

describe('applyBackgroundActivationPolicy', () => {
  function makeApp() {
    return {
      dock: { hide: vi.fn(() => {}), show: vi.fn(async () => {}) },
      setActivationPolicy: vi.fn((_policy: 'accessory' | 'prohibited' | 'regular') => {})
    }
  }

  it('keeps a windowless macOS serve out of the Dock until it hosts a desktop window', () => {
    const app = makeApp()
    expect(
      applyBackgroundActivationPolicy({
        app,
        env: {},
        platform: 'darwin',
        serveWithoutDesktopWindow: true
      })
    ).toBe(true)
    expect(app.setActivationPolicy).toHaveBeenLastCalledWith('accessory')

    expect(applyServeDesktopWindowActivationPolicy({ app, env: {}, platform: 'darwin' })).toBe(true)
    expect(app.setActivationPolicy).toHaveBeenLastCalledWith('regular')
    expect(app.dock.show).toHaveBeenCalledOnce()
  })

  it('never gives a background serve its Dock tile back', () => {
    const app = makeApp()
    expect(
      applyServeDesktopWindowActivationPolicy({
        app,
        env: { ORCA_BACKGROUND_LAUNCH: '1' },
        platform: 'darwin'
      })
    ).toBe(false)
    expect(
      applyServeDesktopWindowActivationPolicy({
        app,
        env: { ORCA_E2E_HEADFUL: '1' },
        platform: 'darwin'
      })
    ).toBe(false)
    expect(app.setActivationPolicy).not.toHaveBeenCalled()
  })
})
