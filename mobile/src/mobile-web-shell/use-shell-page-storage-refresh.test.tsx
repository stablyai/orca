import { createElement, useEffect } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import { useShellPageStorageRefresh } from './use-shell-page-storage-refresh'
import { useSerializedStoredState } from '../storage/use-serialized-stored-state'
import {
  persistMirrored,
  hydrateMirroredStorage,
  readMirroredStorage,
  retainMirroredStorage,
  writeMirroredStorage
} from '../storage/mirrored-storage-keys'
import { TERMINAL_SHORTCUT_STORAGE_KEYS } from './page-storage-keys'

const store = vi.hoisted(() => ({
  values: new Map<string, string>(),
  pending: new Array<() => void>()
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    setItem: (key: string, value: string) =>
      new Promise<void>((resolve) =>
        store.pending.push(() => {
          store.values.set(key, value)
          resolve()
        })
      ),
    getItem: async (key: string) => store.values.get(key) ?? null,
    multiGet: async (keys: string[]) => keys.map((key) => [key, store.values.get(key) ?? null])
  }
}))
const focus = vi.hoisted(() => ({ active: true }))
const app = vi.hoisted(() => ({ listener: (_state: string) => {}, remove: vi.fn() }))
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) =>
    useEffect(() => (focus.active ? effect() : undefined), [effect, focus.active])
}))
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      app.listener = listener
      return { remove: app.remove }
    }
  }
}))

beforeEach(() => {
  focus.active = true
  app.remove.mockClear()
  store.values.clear()
  store.pending.length = 0
})

it('refreshes before publishing on native return and foreground, and drops a blurred completion', async () => {
  let finish!: () => void
  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const publish = vi.fn()
  function Harness() {
    useShellPageStorageRefresh(refresh, publish)
    return null
  }
  let renderer!: ReturnType<typeof create>
  act(() => {
    renderer = create(createElement(Harness))
  })
  expect(publish).not.toHaveBeenCalled()
  focus.active = false
  act(() => renderer.update(createElement(Harness)))
  await act(async () => finish())
  expect(publish).not.toHaveBeenCalled()
  focus.active = true
  act(() => renderer.update(createElement(Harness)))
  await act(async () => finish())
  expect(publish).toHaveBeenCalledTimes(1)
  act(() => app.listener('active'))
  await act(async () => finish())
  expect(publish).toHaveBeenCalledTimes(2)
  act(() => renderer.unmount())
  expect(app.remove).toHaveBeenCalledTimes(2)
})

it.each(TERMINAL_SHORTCUT_STORAGE_KEYS)(
  'publishes the final queued native save for %s, only while focused',
  async (key) => {
    focus.active = false
    store.values.set(key, 'initial')
    // The shell screen holds its route's keys while mounted, as use-page-host-snapshot does.
    const releaseKeys = retainMirroredStorage([key])
    let page = 'initial'
    const save = vi.fn((value: string) => persistMirrored(key, value))
    const load = async () => store.values.get(key) ?? 'initial'
    const refresh = () => hydrateMirroredStorage([key])
    const publish = vi.fn(() => {
      page = readMirroredStorage([key])[key]!
    })
    let settings!: ReturnType<typeof useSerializedStoredState<string>>
    function Harness() {
      settings = useSerializedStoredState('initial', load, save)
      useShellPageStorageRefresh(refresh, publish)
      return null
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      settings.persist('first-toggle')
      settings.persist('second-toggle')
    })
    expect(save).toHaveBeenCalledTimes(1)
    focus.active = true
    await act(async () => {
      store.pending.shift()!()
      renderer.update(createElement(Harness))
    })
    expect(page).toBe('first-toggle')
    expect(save).toHaveBeenCalledTimes(2)
    await act(async () => store.pending.shift()!())
    expect(store.values.get(key)).toBe('second-toggle')
    expect(page).toBe('second-toggle')

    const completed = publish.mock.calls.length
    writeMirroredStorage(key, 'page-local-edit')
    await act(async () => store.pending.shift()!())
    expect(publish).toHaveBeenCalledTimes(completed)
    const unrelated = persistMirrored('orca:hostDockWidth', '450')
    await act(async () => {
      store.pending.shift()!()
      await unrelated
    })
    expect(publish).toHaveBeenCalledTimes(completed)

    focus.active = false
    act(() => renderer.update(createElement(Harness)))
    await act(async () => settings.persist('saved-while-covered'))
    await act(async () => store.pending.shift()!())
    expect(publish).toHaveBeenCalledTimes(completed)
    focus.active = true
    await act(async () => renderer.update(createElement(Harness)))
    expect(page).toBe('saved-while-covered')
    act(() => renderer.unmount())
    const afterUnmount = publish.mock.calls.length
    const later = persistMirrored(key, 'later-session')
    await act(async () => {
      store.pending.shift()!()
      await later
    })
    expect(publish).toHaveBeenCalledTimes(afterUnmount)
    releaseKeys()
  }
)
