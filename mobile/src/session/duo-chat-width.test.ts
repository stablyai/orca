import { createElement, Fragment, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DUO_CHAT_EXPANDED_KEY } from './duo-chat-width'

const io = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (key: string): Promise<string | null> => Promise.resolve(store.get(key) ?? null),
    setItem: (key: string, value: string): Promise<void> => {
      store.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key: string): Promise<void> => {
      store.delete(key)
      return Promise.resolve()
    }
  }
})

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string) => io.getItem(key),
    setItem: (key: string, value: string) => io.setItem(key, value),
    removeItem: (key: string) => io.removeItem(key),
    multiGet: (keys: readonly string[]) =>
      Promise.all(keys.map(async (key) => [key, await io.getItem(key)] as const))
  }
}))

type WidthModule = typeof import('./duo-chat-width')

let unmount = (): void => {}

afterEach(async () => {
  const done = unmount
  unmount = () => {}
  await done()
  io.store.clear()
  io.getItem = (key) => Promise.resolve(io.store.get(key) ?? null)
  io.setItem = (key, value) => {
    io.store.set(key, value)
    return Promise.resolve()
  }
  io.removeItem = (key) => {
    io.store.delete(key)
    return Promise.resolve()
  }
})

async function load(): Promise<WidthModule> {
  vi.resetModules()
  return import('./duo-chat-width')
}

async function mount(pref: WidthModule): Promise<{ read: () => readonly boolean[] }> {
  const held = { values: [] as boolean[] }
  function First(): null {
    held.values[0] = pref.useDuoChatExpanded()
    return null
  }
  function Second(): null {
    held.values[1] = pref.useDuoChatExpanded()
    return null
  }
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(First))
  })
  await act(async () => {
    renderer.update(
      createElement(Fragment, null, createElement(First), createElement(Second)) as ReactElement
    )
    await Promise.resolve()
  })
  unmount = () => act(() => renderer.unmount())
  return { read: () => held.values }
}

describe('the device-wide Duo chat width', () => {
  it('starts expanded and collapses every open chat together', async () => {
    const pref = await load()
    const view = await mount(pref)
    expect(view.read()).toEqual([true, true])

    await act(async () => {
      pref.toggleDuoChatExpanded()
      await Promise.resolve()
    })

    expect(view.read()).toEqual([false, false])
    expect(io.store.get(DUO_CHAT_EXPANDED_KEY)).toBe('false')
  })

  it('opens the next chat collapsed after a restart', async () => {
    io.store.set(DUO_CHAT_EXPANDED_KEY, 'false')
    const pref = await load()
    const view = await mount(pref)
    expect(view.read()).toEqual([false, false])
  })

  it('keeps a collapse made while the saved value is still loading', async () => {
    let finish!: (value: string | null) => void
    io.getItem = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const pref = await load()
    const view = await mount(pref)
    expect(view.read()[0]).toBe(true)

    await act(async () => {
      pref.toggleDuoChatExpanded()
    })
    await act(async () => {
      finish('true')
      await Promise.resolve()
    })

    expect(view.read()).toEqual([false, false])
    expect(io.store.get(DUO_CHAT_EXPANDED_KEY)).toBe('false')
  })

  it('applies a collapse stored by another open chat', async () => {
    const pref = await load()
    const view = await mount(pref)
    await act(async () => {
      pref.applyStoredDuoChatExpanded('false')
    })
    expect(view.read()).toEqual([false, false])
  })

  it('ignores a stale stored value while a toggle is still saving', async () => {
    let finish!: () => void
    io.setItem = () =>
      new Promise((resolve) => {
        finish = () => {
          io.store.set(DUO_CHAT_EXPANDED_KEY, 'false')
          resolve()
        }
      })
    const pref = await load()
    const view = await mount(pref)
    await act(async () => {
      pref.toggleDuoChatExpanded()
    })
    await act(async () => {
      pref.applyStoredDuoChatExpanded('true')
    })
    expect(view.read()).toEqual([false, false])
    await act(async () => {
      finish()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(view.read()).toEqual([false, false])
    expect(io.store.get(DUO_CHAT_EXPANDED_KEY)).toBe('false')
  })
})
