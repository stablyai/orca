import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'

const native: {
  system: string
  cached: string
  active: ((state: string) => void) | null
  direct: string | null
  changed: (() => void) | null
  set: ReturnType<typeof vi.fn<(preference: string) => void>>
} = vi.hoisted(() => ({
  system: 'light',
  cached: 'light',
  active: null,
  direct: null,
  changed: null,
  set: vi.fn()
}))
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Appearance: {
    getColorScheme: () => native.cached,
    setColorScheme: (preference: string) => {
      native.set(preference)
      native.cached = preference === 'unspecified' ? native.system : preference
    },
    addChangeListener: () => ({ remove: vi.fn() })
  },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.active = listener
      return { remove: vi.fn() }
    }
  }
}))
vi.mock('../platform/native-window-appearance', () => ({
  applyNativeWindowAppearance: vi.fn(),
  getNativeSystemColorScheme: () => native.direct,
  subscribeNativeSystemAppearance: (listener: () => void) => {
    native.changed = listener
    return () => {}
  }
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => 'system', setItem: vi.fn(async () => {}) }
}))
import { useMobileAppearance } from './use-mobile-appearance'
import { applyMobileColorScheme, getMobileColorScheme } from './mobile-theme'

it('refreshes a missed background system change on resume while retaining manual overrides', async () => {
  let pending: FrameRequestCallback | null = null
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pending = callback
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    pending = null
  })
  function resume() {
    act(() => native.active!('active'))
    act(() => {
      pending?.(0)
      pending = null
    })
  }
  let settings!: ReturnType<typeof useMobileAppearance>
  function Probe() {
    settings = useMobileAppearance()
    return null
  }
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(createElement(Probe))
  })
  try {
    expect(settings.ready).toBe(true)
    expect(getMobileColorScheme()).toBe('light')
    // Native configuration changed while backgrounded, without an Appearance event reaching JS.
    native.active!('background')
    native.system = 'dark'
    expect(native.cached).toBe('light')
    resume()
    expect(getMobileColorScheme()).toBe('dark')
    // The native system query remains authoritative even if Activity/JS caches lag.
    native.direct = 'light'
    // A fast background/resume may not produce any AppState transition in JS.
    act(() => native.changed!())
    expect(getMobileColorScheme()).toBe('light')
    native.direct = null
    native.system = 'light'
    await act(async () => {
      await settings.setPreference('dark')
    })
    const calls = native.set.mock.calls.length
    resume()
    expect(native.set).toHaveBeenCalledTimes(calls)
    expect(getMobileColorScheme()).toBe('dark')
    await act(async () => {
      await settings.setPreference('system')
    })
    expect(getMobileColorScheme()).toBe('light')
  } finally {
    act(() => tree.unmount())
    applyMobileColorScheme('dark')
    vi.unstubAllGlobals()
  }
})
