import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ isDashboardPopoutRenderer: vi.fn() }))

vi.mock('./dashboard-popout-window', () => ({
  isDashboardPopoutRenderer: mocks.isDashboardPopoutRenderer
}))

import { resolveHelpMenuEventTarget } from './help-menu-event-target'

function fakeWindow(destroyed = false): BrowserWindow {
  return {
    isDestroyed: () => destroyed,
    webContents: { id: destroyed ? 0 : 1 }
  } as unknown as BrowserWindow
}

beforeEach(() => {
  mocks.isDashboardPopoutRenderer.mockReset()
  mocks.isDashboardPopoutRenderer.mockReturnValue(false)
})

describe('resolveHelpMenuEventTarget', () => {
  it('keeps an ordinary invoking window so hidden and multi-window flows stay on their renderer', () => {
    const invoking = fakeWindow()

    expect(resolveHelpMenuEventTarget(invoking, fakeWindow())).toEqual({
      window: invoking,
      surfaceMainWindow: false
    })
  })

  it('redirects the dashboard pop-out to the main window instead of dropping the click', () => {
    mocks.isDashboardPopoutRenderer.mockReturnValue(true)
    const mainWindow = fakeWindow()

    expect(resolveHelpMenuEventTarget(fakeWindow(), mainWindow)).toEqual({
      window: mainWindow,
      surfaceMainWindow: true
    })
  })

  it('falls back to the main window when the menu reports no invoking window', () => {
    const mainWindow = fakeWindow()

    expect(resolveHelpMenuEventTarget(null, mainWindow)).toEqual({
      window: mainWindow,
      surfaceMainWindow: false
    })
    expect(resolveHelpMenuEventTarget(fakeWindow(true), mainWindow).window).toBe(mainWindow)
  })

  it('reports no window rather than a destroyed main window', () => {
    mocks.isDashboardPopoutRenderer.mockReturnValue(true)

    expect(resolveHelpMenuEventTarget(fakeWindow(), fakeWindow(true))).toEqual({
      window: null,
      surfaceMainWindow: true
    })
    expect(resolveHelpMenuEventTarget(null, null).window).toBeNull()
  })
})
