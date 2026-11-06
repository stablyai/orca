import type * as PageStorage from '../mobile-web-shell/bridge/page-async-storage'
import type * as Preference from './selectable-sidebar-sessions'
import { afterEach, describe, expect, it, vi } from 'vitest'

const KEY = 'orca:selectableSidebarSessions'
const LEGACY_KEY = 'orca.selectableSidebarSessions'
const HOST = 'host-1'

const appStore = new Map<string, string>()
const nativeStore = new Map<string, string>()
let unmount = (): void => {}

type PreferenceModule = typeof Preference

afterEach(async () => {
  const done = unmount
  unmount = () => {}
  await done()
})

async function mount(pref: PreferenceModule): Promise<{
  read: () => boolean
  apply: (body?: () => void) => Promise<void>
}> {
  const { createElement } = await import('react')
  const { act, create } = await import('react-test-renderer')
  const held: { value: boolean } = { value: false }
  function Probe(): null {
    held.value = pref.useSelectableSidebarSessions()
    return null
  }
  const apply = async (body?: () => void): Promise<void> => {
    await act(async () => {
      body?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  await act(async () => {
    const renderer = create(createElement(Probe))
    unmount = () => act(() => renderer.unmount())
  })
  await apply()
  return { read: () => held.value, apply }
}

async function loadPage(): Promise<PreferenceModule> {
  vi.resetModules()
  vi.doMock('@react-native-async-storage/async-storage', async () => ({
    default: (await import('../mobile-web-shell/bridge/page-async-storage')).default
  }))
  const storage: typeof PageStorage = await import('../mobile-web-shell/bridge/page-async-storage')
  const pref = await import('./selectable-sidebar-sessions')
  storage.publishPageStorage(
    Object.fromEntries(appStore),
    (key, value) => {
      if (value === null) {
        appStore.delete(key)
      } else {
        appStore.set(key, value)
      }
      return true
    },
    HOST,
    `/h/${HOST}`
  )
  return pref
}

async function loadNative(): Promise<PreferenceModule> {
  vi.resetModules()
  vi.doMock('@react-native-async-storage/async-storage', () => ({
    default: {
      getItem: async (key: string) => nativeStore.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        nativeStore.set(key, value)
      },
      removeItem: async (key: string) => {
        nativeStore.delete(key)
      }
    }
  }))
  return import('./selectable-sidebar-sessions')
}

describe('select sessions across page remounts', () => {
  it('keeps the choice the next page is given', async () => {
    appStore.clear()
    const first = await loadPage()
    const view = await mount(first)
    expect(view.read()).toBe(false)
    await view.apply(() => first.setSelectableSidebarSessions(true))
    expect(appStore.get(KEY)).toBe('1')
    await unmount()

    const second = await loadPage()
    const again = await mount(second)
    expect(again.read()).toBe(true)
  })
})

describe('select sessions in the native shell', () => {
  it('keeps the choice after the module loads again', async () => {
    nativeStore.clear()
    const first = await loadNative()
    const view = await mount(first)
    expect(view.read()).toBe(false)
    await view.apply(() => first.setSelectableSidebarSessions(true))
    await unmount()

    const second = await loadNative()
    const again = await mount(second)
    expect(again.read()).toBe(true)
    expect(nativeStore.get(KEY)).toBe('1')
  })

  it('copies a saved dot-key choice onto the page key', async () => {
    nativeStore.clear()
    nativeStore.set(LEGACY_KEY, '1')
    const pref = await loadNative()
    const view = await mount(pref)
    expect(view.read()).toBe(true)
    expect(nativeStore.get(KEY)).toBe('1')
    expect(nativeStore.has(LEGACY_KEY)).toBe(false)
  })

  it('stays readable when the legacy copy cannot be saved', async () => {
    vi.resetModules()
    vi.doMock('@react-native-async-storage/async-storage', () => ({
      default: {
        getItem: async (key: string) => (key === LEGACY_KEY ? '1' : null),
        setItem: async () => {
          throw new Error('disk')
        },
        removeItem: async () => {}
      }
    }))
    const pref = await import('./selectable-sidebar-sessions')
    const view = await mount(pref)
    expect(view.read()).toBe(false)
  })
})
