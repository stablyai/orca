import { describe, expect, it } from 'vitest'

import { isMainWindowVisible } from './main-window-visibility'

describe('main window visibility helpers', () => {
  it('treats a minimal alive window double as visible', () => {
    expect(isMainWindowVisible({ isDestroyed: () => false })).toBe(true)
  })

  it('parks work when the real window is hidden, minimized, destroyed, or missing', () => {
    expect(
      isMainWindowVisible({
        isDestroyed: () => false,
        isVisible: () => false,
        isMinimized: () => false
      })
    ).toBe(false)
    expect(
      isMainWindowVisible({
        isDestroyed: () => false,
        isVisible: () => true,
        isMinimized: () => true
      })
    ).toBe(false)
    expect(isMainWindowVisible({ isDestroyed: () => true })).toBe(false)
    expect(isMainWindowVisible(null)).toBe(false)
  })
})
