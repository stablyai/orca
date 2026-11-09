import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { publishPageDeviceStore } from '../mobile-web-shell/bridge/page-device-store'
import { resetKeptDraftsForTests, useKeptTextDraft } from './use-kept-draft'

// The shell's draft table outlives the page; nothing else does.
const table = new Map<string, string>()
let renderer: ReactTestRenderer | null = null
let field: ReturnType<typeof useKeptTextDraft> | null = null

const KEY = 'draft:commit:wt-1:host-1::'

function Field(): null {
  field = useKeptTextDraft(KEY)
  return null
}

async function open(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(Field))
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function type(text: string): Promise<void> {
  act(() => field?.[1](text))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
}

// A kill: the page and its memory go, the store stays.
function kill(): void {
  act(() => renderer?.unmount())
  renderer = null
  resetKeptDraftsForTests()
}

beforeEach(() => {
  vi.useFakeTimers()
  publishPageDeviceStore({
    available: () => true,
    read: async (_table, keys) => ({
      status: 'ok',
      values: keys.map((key) => table.get(key) ?? null)
    }),
    write: async (_table, ops) => {
      for (const op of ops) {
        if (op.value === null) {
          table.delete(op.key)
        } else {
          table.set(op.key, op.value)
        }
      }
      return { written: true }
    }
  })
})

afterEach(() => {
  kill()
  table.clear()
  publishPageDeviceStore(null)
  vi.useRealTimers()
})

it('brings typed text back into the field after the app is killed', async () => {
  await open()
  await type('fix the login race')
  kill()

  await open()
  expect(field?.[0]).toBe('fix the login race')
})

it('lets text typed before the saved copy is read win over it', async () => {
  await open()
  await type('older message')
  kill()

  act(() => {
    renderer = create(createElement(Field))
  })
  await type('newer message')
  kill()

  await open()
  expect(field?.[0]).toBe('newer message')
})

it('does not bring back text once the field is emptied', async () => {
  await open()
  await type('committed message')
  await type('')
  kill()

  await open()
  expect(field?.[0]).toBe('')
  expect(table.size).toBe(0)
})
