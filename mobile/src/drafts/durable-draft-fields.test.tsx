import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import {
  publishPageDeviceStore,
  readPageDeviceStore
} from '../mobile-web-shell/bridge/page-device-store'
import { encodeDeviceStoreValue } from '../device-store/device-store-value-codec'
import { resetDurableDraftFieldsForTests, useDurableDraftField } from './durable-draft-fields'
import { publishInMemoryDeviceStore } from './in-memory-device-store.test-support'

const KEY = 'draft:prEdit:wt:main'
let renderer: ReactTestRenderer | null = null
let field: ReturnType<typeof useDurableDraftField> | null = null

function Field() {
  field = useDurableDraftField(KEY, 'body')
  return null
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  resetDurableDraftFieldsForTests()
  publishPageDeviceStore(null)
})

it('keeps a field the user cleared while the saved copy was still being read', async () => {
  // The shell holds an earlier draft, and its read answers only when released.
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  publishPageDeviceStore({
    available: () => true,
    read: async () => {
      await held
      return { status: 'ok', values: [encodeDeviceStoreValue({ body: 'old saved text' })] }
    },
    write: async () => ({ written: true })
  })
  await act(async () => {
    renderer = create(createElement(Field))
  })

  act(() => field![1](''))
  await act(async () => {
    release()
    await held
  })

  expect(field![0]).toBe('')
})

it('drops an older draft once the text grows past what the store can hold', async () => {
  vi.useFakeTimers()
  const table = new Map<string, string>()
  publishInMemoryDeviceStore(table)
  const open = async () => {
    await act(async () => {
      renderer = create(createElement(Field))
      await vi.advanceTimersByTimeAsync(0)
    })
  }
  const kill = () => {
    act(() => renderer?.unmount())
    renderer = null
    resetDurableDraftFieldsForTests()
  }
  await open()
  act(() => field![1]('a short description'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  // Text that doesn't compress, well past the store's 512 KiB cap once encoded.
  let seed = 7
  const huge = Array.from({ length: 900_000 }, () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return String.fromCharCode(33 + ((seed >>> 0) % 90))
  }).join('')
  act(() => field![1](huge))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  kill()

  await open()
  expect(field![0]).toBe('')
  vi.useRealTimers()
})

it('saves text typed while the store could not be read once the store answers again', async () => {
  vi.useFakeTimers()
  const table = new Map<string, string>()
  publishInMemoryDeviceStore(table)
  const store = readPageDeviceStore()!
  let readFails = true
  publishPageDeviceStore({
    ...store,
    read: async (name, keys) => (readFails ? { status: 'unavailable' } : store.read(name, keys))
  })
  await act(async () => {
    renderer = create(createElement(Field))
    await vi.advanceTimersByTimeAsync(0)
  })
  act(() => field![1]('typed while the store was down'))
  readFails = false
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
  act(() => renderer?.unmount())
  renderer = null
  resetDurableDraftFieldsForTests()

  await act(async () => {
    renderer = create(createElement(Field))
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(field![0]).toBe('typed while the store was down')
  vi.useRealTimers()
})

it('does not bring back a saved draft the user cleared while the store could not be read', async () => {
  vi.useFakeTimers()
  const table = new Map([[KEY, encodeDeviceStoreValue({ body: 'already sent text' })]])
  publishInMemoryDeviceStore(table)
  const store = readPageDeviceStore()!
  let readFails = true
  publishPageDeviceStore({
    ...store,
    read: async (name, keys) => (readFails ? { status: 'unavailable' } : store.read(name, keys))
  })
  await act(async () => {
    renderer = create(createElement(Field))
    await vi.advanceTimersByTimeAsync(0)
  })
  // The send landed: its success handler clears a field that is already empty on this page.
  act(() => field![1](''))
  readFails = false
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
  act(() => renderer?.unmount())
  renderer = null
  resetDurableDraftFieldsForTests()

  await act(async () => {
    renderer = create(createElement(Field))
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(field![0]).toBe('')
  vi.useRealTimers()
})
