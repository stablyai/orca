import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { publishPageDeviceStore } from '../mobile-web-shell/bridge/page-device-store'
import { encodeDeviceStoreValue } from '../device-store/device-store-value-codec'
import { resetDurableDraftFieldsForTests, useDurableDraftField } from './durable-draft-fields'

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
