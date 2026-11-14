import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BaseWindow: { getFocusedWindow: () => null } }))

const { focusExistingMainWindow } = await import('./focus-existing-window')

function makeWindow(visible: boolean) {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => visible,
    restore: vi.fn(),
    show: vi.fn(),
    showInactive: vi.fn(),
    focus: vi.fn(),
    moveTop: vi.fn(),
    isAlwaysOnTop: () => false,
    setAlwaysOnTop: vi.fn()
  }
}

describe('focusExistingMainWindow for a background open', () => {
  // The test runner itself launches in the background, which would hide what the request decides.
  beforeEach(() => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('shows a hidden window without taking the foreground', () => {
    const window = makeWindow(false)
    const app = { focus: vi.fn(), isReady: () => true }

    focusExistingMainWindow({
      app,
      background: true,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the background path reads only these window methods.
      getWindow: () => window as unknown as BrowserWindow,
      openWindow: vi.fn(),
      platform: 'win32',
      setTimeout: vi.fn()
    })

    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(app.focus).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    expect(window.moveTop).not.toHaveBeenCalled()
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled()
  })

  it('opens a missing window to reveal itself in the background', () => {
    const window = makeWindow(false)
    const app = { focus: vi.fn(), isReady: () => true }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the background path reads only these window methods.
    const openWindow = vi.fn((_options?: unknown) => window as unknown as BrowserWindow)

    expect(
      focusExistingMainWindow({
        app,
        background: true,
        getWindow: () => null,
        openWindow,
        platform: 'win32',
        setTimeout: vi.fn()
      })
    ).toBe('opened')

    expect(openWindow).toHaveBeenCalledWith({ revealInBackground: true })
    expect(app.focus).not.toHaveBeenCalled()
    expect(window.showInactive).not.toHaveBeenCalled()
  })
})
