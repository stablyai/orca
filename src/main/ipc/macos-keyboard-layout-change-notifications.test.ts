import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeModule from 'node:module'
import type { KeyboardLayoutSnapshot } from '../../shared/keyboard-layout-snapshot'

const { appOnce, getAllWindows, subscribeNotification, unsubscribeNotification, nativeRequire } =
  vi.hoisted(() => ({
    appOnce: vi.fn(),
    getAllWindows: vi.fn(),
    subscribeNotification: vi.fn(),
    unsubscribeNotification: vi.fn(),
    nativeRequire: vi.fn()
  }))

vi.mock('electron', () => ({
  app: { once: appOnce, removeListener: vi.fn() },
  BrowserWindow: { getAllWindows },
  systemPreferences: { subscribeNotification, unsubscribeNotification }
}))

vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeModule>()),
  createRequire: () => nativeRequire
}))

function layout(inputSourceId: string, KeyQ: string): KeyboardLayoutSnapshot {
  return {
    inputSourceId,
    layoutSourceId: inputSourceId,
    keyCharacters: { KeyQ: { unmodified: KeyQ, shifted: KeyQ.toUpperCase() } }
  }
}

const US = layout('com.apple.keylayout.US', 'q')
const FRENCH = layout('com.apple.keylayout.French', 'a')

describe('macOS keyboard layout snapshot', () => {
  const originalPlatform = process.platform
  let current: KeyboardLayoutSnapshot | null
  let keyboardType: number
  let nativeReads: number

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    Object.defineProperty(process, 'resourcesPath', {
      value: '/Orca.app/Contents/Resources',
      configurable: true
    })
    current = US
    keyboardType = 40
    nativeReads = 0
    nativeRequire.mockReturnValue({
      read: () => {
        nativeReads++
        return current ? { snapshot: current, keyboardType } : null
      },
      keyboardType: () => keyboardType
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  async function load(): Promise<{
    read: () => KeyboardLayoutSnapshot | null
    notifyInputSourceChanged: () => void
    dispose: () => void
  }> {
    let notifyInputSourceChanged = (): void => undefined
    subscribeNotification.mockImplementation((_name: string, callback: () => void) => {
      notifyInputSourceChanged = callback
      return 7
    })
    const { registerMacKeyboardLayoutChangeNotifications } =
      await import('./macos-keyboard-layout-change-notifications')
    const { readMacKeyboardLayoutSnapshot } = await import('./macos-keyboard-layout-snapshot')
    const dispose = registerMacKeyboardLayoutChangeNotifications()
    return {
      read: readMacKeyboardLayoutSnapshot,
      notifyInputSourceChanged: () => notifyInputSourceChanged(),
      dispose
    }
  }

  it('reads an unchanged layout once and serves the new layout to the refresh after an input-source change', async () => {
    const { read, notifyInputSourceChanged } = await load()
    expect([read(), read(), read()]).toEqual([US, US, US])
    expect(nativeReads).toBe(1)

    const refreshed: (KeyboardLayoutSnapshot | null)[] = []
    getAllWindows.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (_channel: string, event: { phase: string }) => {
            if (event.phase === 'refresh') {
              refreshed.push(read())
            }
          }
        }
      }
    ])
    current = FRENCH
    notifyInputSourceChanged()
    expect(refreshed).toEqual([FRENCH])
    expect(read()).toEqual(FRENCH)
    expect(nativeReads).toBe(2)
  })

  it('reads again when the keyboard type changes without an input-source change', async () => {
    const { read } = await load()
    read()
    keyboardType = 41
    current = FRENCH
    expect(read()).toEqual(FRENCH)
  })

  it('never pins a layout without a live subscription', async () => {
    subscribeNotification.mockImplementation(() => {
      throw new Error('unavailable')
    })
    const { registerMacKeyboardLayoutChangeNotifications } =
      await import('./macos-keyboard-layout-change-notifications')
    const { readMacKeyboardLayoutSnapshot } = await import('./macos-keyboard-layout-snapshot')
    registerMacKeyboardLayoutChangeNotifications()
    expect(readMacKeyboardLayoutSnapshot()).toEqual(US)
    current = FRENCH
    expect(readMacKeyboardLayoutSnapshot()).toEqual(FRENCH)
  })

  it('stops serving the cache after quit disposes the subscription', async () => {
    const { read, dispose } = await load()
    read()
    dispose()
    current = FRENCH
    expect(read()).toEqual(FRENCH)
    expect(unsubscribeNotification).toHaveBeenCalledTimes(1)
  })

  it('retries a failed native load and a failed read', async () => {
    nativeRequire.mockImplementationOnce(() => {
      throw new Error('dlopen failed')
    })
    const { read } = await load()
    expect(read()).toBeNull()
    current = null
    expect(read()).toBeNull()
    current = US
    expect(read()).toEqual(US)
  })
})
