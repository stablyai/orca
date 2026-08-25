import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getFocusedWebContentsMock } = vi.hoisted(() => ({
  getFocusedWebContentsMock: vi.fn()
}))

vi.mock('electron', () => ({
  webContents: { getFocusedWebContents: getFocusedWebContentsMock }
}))

import { resolveEditMenuTarget } from './edit-menu-focus-target'

describe('resolveEditMenuTarget', () => {
  const hostContents = {} as Electron.WebContents
  const focusedWindow = { webContents: hostContents } as Electron.BrowserWindow

  beforeEach(() => {
    getFocusedWebContentsMock.mockReset()
  })

  it('returns the inner contents when DevTools or a guest view holds focus', () => {
    const devToolsContents = {} as Electron.WebContents
    getFocusedWebContentsMock.mockReturnValue(devToolsContents)

    expect(resolveEditMenuTarget(focusedWindow)).toBe(devToolsContents)
  })

  it('returns null when the window renderer itself holds focus', () => {
    getFocusedWebContentsMock.mockReturnValue(hostContents)

    expect(resolveEditMenuTarget(focusedWindow)).toBeNull()
  })

  it('returns null when nothing holds focus', () => {
    getFocusedWebContentsMock.mockReturnValue(null)

    expect(resolveEditMenuTarget(focusedWindow)).toBeNull()
  })
})
