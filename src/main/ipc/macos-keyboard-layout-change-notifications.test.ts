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
import {
  MAC_KEYBOARD_INPUT_SOURCE_CHANGED_NOTIFICATION,
  registerMacKeyboardLayoutChangeNotifications
} from './macos-keyboard-layout-change-notifications'

describe('macOS keyboard layout change notifications', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('invalidates immediately, refreshes after the old read, and unsubscribes on quit', async () => {
    let notificationCallback: (() => void) | undefined
    let finishRead!: () => void
    waitForSnapshotIdle.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRead = resolve
      })
    )
    subscribeNotification.mockImplementation((_name: string, callback: () => void) => {
      notificationCallback = callback
      return 41
    })
    const send = vi.fn()
    getAllWindows.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: vi.fn(() => {
            throw new Error('window closed')
          })
        }
      },
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } },
      {
        isDestroyed: () => true,
        webContents: { isDestroyed: () => false, send: vi.fn() }
      }
    ])

    registerMacKeyboardLayoutChangeNotifications()
    expect(subscribeNotification).toHaveBeenCalledWith(
      MAC_KEYBOARD_INPUT_SOURCE_CHANGED_NOTIFICATION,
      expect.any(Function)
    )

    notificationCallback?.()
    expect(send).toHaveBeenCalledExactlyOnceWith(KEYBOARD_LAYOUT_CHANGED_CHANNEL, {
      phase: 'invalidated',
      generation: 1
    })
    finishRead()
    await Promise.resolve()
    await Promise.resolve()
    expect(send).toHaveBeenNthCalledWith(2, KEYBOARD_LAYOUT_CHANGED_CHANNEL, {
      phase: 'refresh',
      generation: 1
    })

    const quitListener = appOnce.mock.calls.find(([event]) => event === 'will-quit')?.[1] as
      | (() => void)
      | undefined
    unsubscribeNotification.mockImplementationOnce(() => {
      throw new Error('native teardown unavailable')
    })
    expect(() => quitListener?.()).not.toThrow()
    expect(unsubscribeNotification).toHaveBeenCalledExactlyOnceWith(41)
    expect(appRemoveListener).toHaveBeenCalledWith('will-quit', quitListener)
    notificationCallback?.()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not install a native subscription off macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    registerMacKeyboardLayoutChangeNotifications()

    expect(subscribeNotification).not.toHaveBeenCalled()
    expect(appOnce).not.toHaveBeenCalled()
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
