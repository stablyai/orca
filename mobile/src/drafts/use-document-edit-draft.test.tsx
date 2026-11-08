import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { publishPageDeviceStore } from '../mobile-web-shell/bridge/page-device-store'
import { dropDocumentEditDraft, resetDocumentEditDraftsForTests } from './document-edit-draft-rows'
import { useDocumentEditDraft } from './use-document-edit-draft'

type Draft = ReturnType<typeof useDocumentEditDraft>

// The shell's draft table outlives the page; nothing else does.
const table = new Map<string, string>()
let renderer: ReactTestRenderer | null = null
let latest: Draft | null = null

const KEY = 'draft:markdownTab:wt:tab-1'

function Editor(props: { base: string; live: string; onRestore: (content: string) => void }) {
  latest = useDocumentEditDraft({ draftKey: KEY, editable: true, ...props })
  return null
}

async function open(base: string, live: string, onRestore = vi.fn()): Promise<void> {
  await act(async () => {
    renderer = create(createElement(Editor, { base, live, onRestore }))
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function type(base: string, live: string): Promise<void> {
  act(() => renderer?.update(createElement(Editor, { base, live, onRestore: vi.fn() })))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
}

// A kill: the page and its memory go, the store stays.
function kill(): void {
  act(() => renderer?.unmount())
  renderer = null
  resetDocumentEditDraftsForTests()
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

it('offers edits back after a kill and restores them when the host still serves their version', async () => {
  await open('# notes\n', '# notes\n')
  await type('# notes\n', '# notes\nship it\n')
  kill()

  const onRestore = vi.fn()
  await open('# notes\n', '# notes\n', onRestore)
  expect(latest?.offer).toMatchObject({ content: '# notes\nship it\n', baseMatches: true })
  expect(onRestore).not.toHaveBeenCalled()

  act(() => latest?.restore())
  expect(onRestore).toHaveBeenCalledWith('# notes\nship it\n')
  expect(latest?.offer).toBeNull()
})

it('never applies edits made against a version the desktop has since changed', async () => {
  await open('# notes\n', '# notes\n')
  await type('# notes\n', '# notes\nship it\n')
  kill()

  const onRestore = vi.fn()
  await open('# notes\nedited on desktop\n', '# notes\nedited on desktop\n', onRestore)
  expect(latest?.offer).toMatchObject({ content: '# notes\nship it\n', baseMatches: false })

  act(() => latest?.restore())
  expect(onRestore).not.toHaveBeenCalled()
  expect(latest?.offer).not.toBeNull()

  act(() => latest?.discardOffer())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(table.size).toBe(0)
})

it('keeps edits on offer when the edits typed over them are discarded', async () => {
  await open('# notes\n', '# notes\n')
  await type('# notes\n', '# notes\nship it\n')
  kill()

  await open('# notes\n', '# notes\n')
  await type('# notes\n', '# notes\nsomething else\n')
  act(() => dropDocumentEditDraft(KEY))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  kill()

  await open('# notes\n', '# notes\n')
  expect(latest?.offer).toMatchObject({ content: '# notes\nship it\n', baseMatches: true })
})
