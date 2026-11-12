import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { dock: { hide: vi.fn() }, setActivationPolicy: vi.fn() } }))

const {
  applyBackgroundActivationPolicy,
  applyServeDesktopWindowActivationPolicy,
  showWindowWithoutStealingFocus
} = await import('./foreground-activation-policy')

function makeWindow(destroyed = false): BrowserWindow & {
  show: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
} {
  return {
    isDestroyed: () => destroyed,
    show: vi.fn(() => {}),
    showInactive: vi.fn(() => {})
  } as unknown as BrowserWindow & {
    show: ReturnType<typeof vi.fn>
    showInactive: ReturnType<typeof vi.fn>
  }
}

describe('showWindowWithoutStealingFocus', () => {
  it('never reveals an explicitly background window', () => {
    const window = makeWindow()
    showWindowWithoutStealingFocus(window, { ORCA_BACKGROUND_LAUNCH: '1' })
    expect(window.showInactive).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
  })

  it('still reveals explicitly headful E2E without activation', () => {
    const window = makeWindow()
    showWindowWithoutStealingFocus(window, { ORCA_E2E_HEADFUL: '1' })
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(window.show).not.toHaveBeenCalled()
  })
})

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
