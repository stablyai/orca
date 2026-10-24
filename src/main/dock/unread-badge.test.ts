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

  it('clears the native badge when unread count is zero', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const { setUnreadDockBadgeCount } = await import('./unread-badge')

    setUnreadDockBadgeCount(5)
    expect(setBadgeMock).toHaveBeenLastCalledWith('5')

    setUnreadDockBadgeCount(0)
    expect(setBadgeMock).toHaveBeenLastCalledWith('')
  })

  it('caps unread counts', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const { setUnreadDockBadgeCount } = await import('./unread-badge')

    setUnreadDockBadgeCount(104)
    expect(setBadgeMock).toHaveBeenLastCalledWith('99+')
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

  it('restores the current unread count when shown again', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const { setUnreadDockBadgeCount, setDockBadgeVisible } = await import('./unread-badge')

    setUnreadDockBadgeCount(3)
    setDockBadgeVisible(false)
    setUnreadDockBadgeCount(7)

    setDockBadgeVisible(true)
    expect(setBadgeMock).toHaveBeenLastCalledWith('7')
  })

  it('ignores visibility changes off macOS', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const { setDockBadgeVisible } = await import('./unread-badge')

    setDockBadgeVisible(false)
    expect(setBadgeMock).not.toHaveBeenCalled()
  })
})
