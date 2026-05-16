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

describe('unread Dock badge', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    setBadgeMock.mockReset()
    vi.resetModules()
  })

  it('shows the dev identity badge when unread count is zero', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const { setIdleDockBadgeLabel, setUnreadDockBadgeCount } = await import('./unread-badge')

    setIdleDockBadgeLabel('DI')
    expect(setBadgeMock).toHaveBeenLastCalledWith('DI')

    setUnreadDockBadgeCount(5)
    expect(setBadgeMock).toHaveBeenLastCalledWith('5')

    setUnreadDockBadgeCount(0)
    expect(setBadgeMock).toHaveBeenLastCalledWith('DI')
  })

  it('caps unread counts while preserving the idle badge', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const { setIdleDockBadgeLabel, setUnreadDockBadgeCount } = await import('./unread-badge')

    setIdleDockBadgeLabel('DI')
    setUnreadDockBadgeCount(104)
    expect(setBadgeMock).toHaveBeenLastCalledWith('99+')
  })
})
