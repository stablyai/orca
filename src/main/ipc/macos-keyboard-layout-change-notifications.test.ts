import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appOnce,
  appRemoveListener,
  getAllWindows,
  subscribeNotification,
  unsubscribeNotification,
  waitForSnapshotIdle
} = vi.hoisted(() => ({
  appOnce: vi.fn(),
  appRemoveListener: vi.fn(),
  getAllWindows: vi.fn(),
  subscribeNotification: vi.fn(),
  unsubscribeNotification: vi.fn(),
  waitForSnapshotIdle: vi.fn()
}))

vi.mock('electron', () => ({
  app: { once: appOnce, removeListener: appRemoveListener },
  BrowserWindow: { getAllWindows },
  systemPreferences: { subscribeNotification, unsubscribeNotification }
}))

vi.mock('./macos-keyboard-layout-snapshot', () => ({
  waitForMacKeyboardLayoutSnapshotIdle: waitForSnapshotIdle
}))

import { KEYBOARD_LAYOUT_CHANGED_CHANNEL } from '../../shared/keyboard-layout-events'
import { registerMacKeyboardLayoutChangeNotifications } from './macos-keyboard-layout-change-notifications'

describe('macOS keyboard layout change notifications', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('coalesces rapid changes before the prior native read settles', async () => {
    let notificationCallback: (() => void) | undefined
    let finishRead!: () => void
    waitForSnapshotIdle.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRead = resolve
      })
    )
    subscribeNotification.mockImplementation((_name: string, callback: () => void) => {
      notificationCallback = callback
      return 42
    })
    const send = vi.fn()
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
    ])

    registerMacKeyboardLayoutChangeNotifications()
    notificationCallback?.()
    notificationCallback?.()
    expect(send.mock.calls).toEqual([
      [KEYBOARD_LAYOUT_CHANGED_CHANNEL, { phase: 'invalidated', generation: 1 }],
      [KEYBOARD_LAYOUT_CHANGED_CHANNEL, { phase: 'invalidated', generation: 2 }]
    ])

    finishRead()
    await Promise.resolve()
    await Promise.resolve()
    expect(send).toHaveBeenLastCalledWith(KEYBOARD_LAYOUT_CHANGED_CHANNEL, {
      phase: 'refresh',
      generation: 2
    })
    expect(send).toHaveBeenCalledTimes(3)
  })
})
