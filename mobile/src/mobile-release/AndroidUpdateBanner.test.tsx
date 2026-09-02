import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkForAndroidUpdate, skipAndroidUpdate } from './android-update-check'
import { AndroidUpdateBanner } from './AndroidUpdateBanner'

const native = vi.hoisted(() => ({
  openUrl: vi.fn(),
  platform: { OS: 'android' as 'ios' | 'android' },
  appStateListeners: [] as Array<(state: string) => void>
}))

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.appStateListeners.push(listener)
      return { remove: vi.fn() }
    }
  },
  Linking: { openURL: native.openUrl },
  Platform: native.platform,
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.0.47' } } }))
vi.mock('lucide-react-native', () => ({ X: 'X' }))
vi.mock('./android-update-check', () => ({
  checkForAndroidUpdate: vi.fn(),
  skipAndroidUpdate: vi.fn()
}))

const update = {
  version: '0.0.48',
  apkUrl:
    'https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.48/app-release.apk'
}

async function render(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(AndroidUpdateBanner))
    await Promise.resolve()
  })
  return renderer as unknown as ReactTestRenderer
}

function pressables(renderer: ReactTestRenderer) {
  return renderer.root.findAll((node) => node.type === 'Pressable')
}

let renderer: ReactTestRenderer | null = null

beforeEach(() => {
  native.platform.OS = 'android'
  native.appStateListeners.length = 0
  native.openUrl.mockReset().mockResolvedValue(undefined)
  vi.mocked(checkForAndroidUpdate).mockReset().mockResolvedValue(update)
  vi.mocked(skipAndroidUpdate).mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('AndroidUpdateBanner', () => {
  it('renders nothing and never checks on iOS', async () => {
    native.platform.OS = 'ios'
    renderer = await render()
    expect(renderer.toJSON()).toBeNull()
    expect(checkForAndroidUpdate).not.toHaveBeenCalled()
  })

  it('checks against the installed version and opens the APK on tap', async () => {
    renderer = await render()
    expect(checkForAndroidUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ currentVersion: '0.0.47' })
    )
    expect(JSON.stringify(renderer.toJSON())).toContain('0.0.48')
    await act(async () => {
      pressables(renderer!)[0].props.onPress()
    })
    expect(native.openUrl).toHaveBeenCalledWith(update.apkUrl)
  })

  it('rechecks when the app returns to the foreground', async () => {
    vi.mocked(checkForAndroidUpdate).mockResolvedValueOnce(null)
    renderer = await render()
    expect(renderer.toJSON()).toBeNull()
    await act(async () => {
      native.appStateListeners.forEach((listener) => listener('active'))
      await Promise.resolve()
    })
    expect(checkForAndroidUpdate).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(renderer.toJSON())).toContain('0.0.48')
  })

  it('skips the version and hides on dismiss', async () => {
    renderer = await render()
    await act(async () => {
      pressables(renderer!)[1].props.onPress()
    })
    expect(skipAndroidUpdate).toHaveBeenCalledWith('0.0.48')
    expect(renderer.toJSON()).toBeNull()
  })
})
