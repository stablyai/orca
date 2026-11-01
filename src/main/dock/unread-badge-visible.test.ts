import { afterEach, describe, expect, it, vi } from 'vitest'

const { setBadgeMock } = vi.hoisted(() => ({
  setBadgeMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    dock: {
      setBadge: setBadgeMock
    }
  }
}))

// Upstream's test-inventory cleanup removed unread-badge.test.ts; this keeps the
// visibility-toggle behavior this feature adds, which that file never covered.
describe('unread Dock badge visibility toggle', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    setBadgeMock.mockReset()
    vi.resetModules()
  })

  it('clears the badge immediately when hidden and keeps it hidden as unread counts change', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const { setUnreadDockBadgeCount, setDockBadgeVisible } = await import('./unread-badge')

    setUnreadDockBadgeCount(3)
    expect(setBadgeMock).toHaveBeenLastCalledWith('3')

    setDockBadgeVisible(false)
    expect(setBadgeMock).toHaveBeenLastCalledWith('')

    setUnreadDockBadgeCount(7)
    expect(setBadgeMock).toHaveBeenLastCalledWith('')
  })
})
