import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const frames = vi.hoisted(() => new Map<string, object>())
vi.mock('electron', () => ({
  webFrameMain: {
    fromId: (process: number, routing: number) => frames.get(`${process}:${routing}`)
  }
}))
vi.mock('../browser-extension-api-host', () => ({ emitBrowserExtensionEvent: () => {} }))
vi.mock('../browser-extension-tab-model', () => ({}))

const { observeBrowserExtensionWebNavigation, chromeFrameDocument } =
  await import('./web-navigation')

it('releases deleted-frame URLs and document IDs while the guest stays alive', async () => {
  const main = { frameTreeNodeId: 999_999, parent: null, processId: 1, isDestroyed: () => false }
  const contents = Object.assign(new EventEmitter(), { id: 7, session: {}, mainFrame: main })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this observer only needs the event emitter, id and session from the guest.
  observeBrowserExtensionWebNavigation(contents as unknown as Electron.WebContents)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: document fields only read the frame ID, parent and process fields stubbed here.
  const mainFrame = main as unknown as Electron.WebFrameMain
  const mainDocument = chromeFrameDocument(mainFrame, true).documentId
  const numericCaches: Map<unknown, unknown>[] = []
  const originalSet = Map.prototype.set
  const set = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown
  ) {
    if (typeof key === 'number' && key >= 1_000_000 && typeof value === 'string') {
      if (!numericCaches.includes(this)) {
        numericCaches.push(this)
      }
    }
    return originalSet.call(this, key, value)
  })
  const retired: WeakRef<object>[] = []
  const churn = (): void => {
    try {
      for (let index = 0; index < 1_000; index++) {
        const id = 1_000_000 + index
        const frame = {
          frameTreeNodeId: id,
          processId: 1,
          routingId: id,
          url: `https://site.test/retired-${index}`,
          parent: main,
          isDestroyed: () => false,
          on: () => {}
        }
        frames.set(`1:${id}`, frame)
        contents.emit('frame-created', {}, { frame })
        contents.emit('did-frame-navigate', {}, frame.url, 200, 'OK', false, 1, id)
        retired.push(new WeakRef(frame))
        frames.delete(`1:${id}`)
      }
    } finally {
      set.mockRestore()
      set.mockClear()
    }
  }
  churn()
  const collect = global.gc
  if (!collect) {
    throw new Error('Run retention tests with --expose-gc')
  }
  for (let index = 0; index < 6; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    collect()
  }
  expect(retired.filter((ref) => ref.deref())).toHaveLength(0)
  expect(
    numericCaches.flatMap((cache) =>
      [...cache.keys()].filter((id) => typeof id === 'number' && id >= 1_000_000)
    )
  ).toHaveLength(0)
  expect(chromeFrameDocument(mainFrame, true).documentId).toBe(mainDocument)
  expect(contents.listenerCount('did-frame-navigate')).toBe(1)
  contents.emit('destroyed')
})
