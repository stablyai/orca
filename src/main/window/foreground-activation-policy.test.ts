import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { dock: { hide: vi.fn() }, setActivationPolicy: vi.fn() } }))

const {
  applyBackgroundActivationPolicy,
  isBackgroundLaunch,
  isWindowlessLaunch,
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

describe('isBackgroundLaunch', () => {
  it('covers headless and headful E2E plus opted-in dev launches', () => {
    expect(isBackgroundLaunch({ ORCA_E2E_HEADLESS: '1' })).toBe(true)
    expect(isBackgroundLaunch({ ORCA_E2E_HEADFUL: '1' })).toBe(true)
    expect(isBackgroundLaunch({ ORCA_BACKGROUND_LAUNCH: '1' })).toBe(true)
    expect(isBackgroundLaunch({})).toBe(false)
  })

  it('lets native-focus specs opt back into the foreground', () => {
    expect(isBackgroundLaunch({ ORCA_E2E_HEADFUL: '1', ORCA_E2E_FOREGROUND: '1' })).toBe(false)
    expect(isWindowlessLaunch({ ORCA_E2E_HEADLESS: '1', ORCA_E2E_FOREGROUND: '1' })).toBe(false)
  })
})

describe('isWindowlessLaunch', () => {
  it('is headless-only; a headful run still paints', () => {
    expect(isWindowlessLaunch({ ORCA_E2E_HEADLESS: '1' })).toBe(true)
    expect(isWindowlessLaunch({ ORCA_E2E_HEADLESS: '1', ORCA_E2E_HEADFUL: '1' })).toBe(false)
    expect(isWindowlessLaunch({ ORCA_BACKGROUND_LAUNCH: '1' })).toBe(false)
  })
})

describe('showWindowWithoutStealingFocus', () => {
  it('keeps a headless window off screen', () => {
    const window = makeWindow()
    showWindowWithoutStealingFocus(window, { ORCA_E2E_HEADLESS: '1' })
    expect(window.show).not.toHaveBeenCalled()
    expect(window.showInactive).not.toHaveBeenCalled()
  })

  it('shows a background window without activating it', () => {
    const window = makeWindow()
    showWindowWithoutStealingFocus(window, { ORCA_BACKGROUND_LAUNCH: '1' })
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(window.show).not.toHaveBeenCalled()
  })

  it('shows normally for a real user launch', () => {
    const window = makeWindow()
    showWindowWithoutStealingFocus(window, {})
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.showInactive).not.toHaveBeenCalled()
  })

  it('ignores a destroyed window', () => {
    const window = makeWindow(true)
    showWindowWithoutStealingFocus(window, {})
    expect(window.show).not.toHaveBeenCalled()
  })
})

describe('applyBackgroundActivationPolicy', () => {
  function makeApp() {
    return {
      dock: { hide: vi.fn(() => {}) },
      setActivationPolicy: vi.fn((_policy: 'accessory' | 'prohibited' | 'regular') => {})
    }
  }

  it('drops the macOS Dock tile and menu bar for headless runs', () => {
    const app = makeApp()
    expect(
      applyBackgroundActivationPolicy({
        app,
        env: { ORCA_E2E_HEADLESS: '1' },
        platform: 'darwin'
      })
    ).toBe(true)
    expect(app.dock.hide).toHaveBeenCalledOnce()
    expect(app.setActivationPolicy).toHaveBeenCalledWith('accessory')
  })

  it('leaves a headful or user launch with its normal Dock presence', () => {
    const headful = makeApp()
    applyBackgroundActivationPolicy({
      app: headful,
      env: { ORCA_E2E_HEADLESS: '1', ORCA_E2E_HEADFUL: '1' },
      platform: 'darwin'
    })
    expect(headful.setActivationPolicy).not.toHaveBeenCalled()

    const user = makeApp()
    applyBackgroundActivationPolicy({ app: user, env: {}, platform: 'darwin' })
    expect(user.setActivationPolicy).not.toHaveBeenCalled()
  })

  it('is a no-op off macOS', () => {
    const app = makeApp()
    expect(
      applyBackgroundActivationPolicy({
        app,
        env: { ORCA_E2E_HEADLESS: '1' },
        platform: 'win32'
      })
    ).toBe(false)
    expect(app.dock.hide).not.toHaveBeenCalled()
  })
})
