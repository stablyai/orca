import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportHtmlToPdfArgs, ExportHtmlToPdfResult } from './export'

type ExportHandler = (
  event: { sender: EventEmitter },
  args: ExportHtmlToPdfArgs
) => Promise<ExportHtmlToPdfResult>

const fake = vi.hoisted(() => ({
  handlers: new Map<string, ExportHandler>(),
  tempFiles: new Set<string>(),
  savedFiles: new Map<string, Uint8Array>(),
  windows: new Array<{ events: EventEmitter; destroyed: boolean }>(),
  uuid: 0,
  write:
    vi.fn<
      (path: string, data: string | Uint8Array, options?: { signal?: AbortSignal }) => Promise<void>
    >(),
  load: vi.fn<(events: EventEmitter, path: string) => Promise<void>>(),
  images: vi.fn<() => Promise<void>>(),
  print: vi.fn<() => Promise<Buffer>>(),
  dialog: vi.fn<() => Promise<{ canceled: boolean; filePath?: string }>>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/mock-export-temp' },
  ipcMain: {
    removeHandler: () => {
      fake.handlers.delete('export:html-to-pdf')
    },
    handle: (_channel: string, handler: ExportHandler) => {
      fake.handlers.set('export:html-to-pdf', handler)
    }
  },
  dialog: { showSaveDialog: fake.dialog },
  BrowserWindow: class {
    static fromWebContents() {
      return { id: 1 }
    }
    events = new EventEmitter()
    destroyed = false
    webContents = Object.assign(this.events, {
      executeJavaScript: fake.images,
      printToPDF: fake.print
    })
    constructor() {
      fake.windows.push(this)
    }
    loadFile(path: string) {
      return fake.load(this.events, path)
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
    }
  }
}))
vi.mock('node:fs/promises', () => ({
  writeFile: fake.write,
  unlink: async (path: string) => {
    fake.tempFiles.delete(path)
  }
}))
vi.mock('node:crypto', () => ({ randomUUID: () => `export-${++fake.uuid}` }))

import { registerExportHandlers } from './export'

const PDF = Buffer.from('exported PDF snapshot')
const ARGS = { html: '<p>captured markdown</p>', title: 'draft' }
const GONE_EVENTS = ['render-process-gone', 'did-navigate', 'destroyed'] as const

function exportFrom(sender: EventEmitter): Promise<ExportHtmlToPdfResult> {
  const handler = fake.handlers.get('export:html-to-pdf')
  if (!handler) {
    throw new Error('Export handler was not registered')
  }
  return handler({ sender }, ARGS)
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

function expectReleased(sender: EventEmitter): void {
  expect(fake.tempFiles.size).toBe(0)
  expect(fake.windows.every((window) => window.destroyed)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  for (const event of GONE_EVENTS) {
    expect(sender.listenerCount(event)).toBe(0)
  }
  for (const window of fake.windows) {
    expect(window.events.listenerCount('did-finish-load')).toBe(0)
    expect(window.events.listenerCount('did-fail-load')).toBe(0)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  fake.tempFiles.clear()
  fake.savedFiles.clear()
  fake.windows.length = 0
  fake.write.mockImplementation(async (path, data) => {
    if (typeof data === 'string') {
      fake.tempFiles.add(path)
    } else {
      fake.savedFiles.set(path, data)
    }
  })
  fake.load.mockImplementation(async (events) => {
    events.emit('did-finish-load')
  })
  fake.images.mockResolvedValue()
  fake.print.mockResolvedValue(PDF)
  fake.dialog.mockResolvedValue({ canceled: true })
  registerExportHandlers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PDF export requesting document lifetime', () => {
  it.each(GONE_EVENTS)('releases a hidden export on %s before images settle', async (event) => {
    const images = Promise.withResolvers<void>()
    fake.images.mockReturnValueOnce(images.promise)
    const sender = new EventEmitter()
    const result = exportFrom(sender)
    await flush()
    expect(fake.tempFiles.size).toBe(1)
    expect(fake.windows).toHaveLength(1)

    sender.emit(event)
    await flush()
    expectReleased(sender)
    await expect(result).resolves.toEqual({ success: false, cancelled: true })
    expectReleased(sender)
    images.resolve()
    await flush()
    expect(fake.print).not.toHaveBeenCalled()
    expect(fake.dialog).not.toHaveBeenCalled()
  })

  it.each(['load', 'load-event', 'images', 'print'] as const)(
    'cleans up pending %s and observes its late rejection',
    async (stage) => {
      const pending = Promise.withResolvers<void>()
      const printing = Promise.withResolvers<Buffer>()
      if (stage === 'load') {
        fake.load.mockReturnValueOnce(pending.promise)
      }
      if (stage === 'load-event') {
        fake.load.mockResolvedValueOnce()
      }
      if (stage === 'images') {
        fake.images.mockReturnValueOnce(pending.promise)
      }
      if (stage === 'print') {
        fake.print.mockReturnValueOnce(printing.promise)
      }
      const sender = new EventEmitter()
      const result = exportFrom(sender)
      await flush()
      sender.emit('render-process-gone')
      await flush()
      expectReleased(sender)
      await expect(result).resolves.toEqual({ success: false, cancelled: true })
      expectReleased(sender)

      if (stage === 'print') {
        printing.reject(new Error('late print failure'))
      } else if (stage === 'load-event') {
        fake.windows[0]?.events.emit('did-fail-load', {}, -3, 'late failure')
      } else {
        pending.reject(new Error('late renderer failure'))
      }
      await flush()
      expect(fake.dialog).not.toHaveBeenCalled()
      expect(fake.print).toHaveBeenCalledTimes(stage === 'print' ? 1 : 0)
    }
  )

  it.each(['resolve', 'reject'] as const)(
    'cancels initial document writing and cleans up after late %s',
    async (settlement) => {
      const writing = Promise.withResolvers<void>()
      fake.write.mockImplementationOnce(async (path) => {
        fake.tempFiles.add(path)
        await writing.promise
      })
      const sender = new EventEmitter()
      const result = exportFrom(sender)
      await flush()
      const signal = fake.write.mock.calls[0]?.[2]?.signal
      expect(signal?.aborted).toBe(false)
      sender.emit('did-navigate')
      expect(signal?.aborted).toBe(true)
      expect(fake.windows).toHaveLength(0)
      expect(fake.tempFiles.size).toBe(1)

      if (settlement === 'resolve') {
        writing.resolve()
      } else {
        writing.reject(new Error('write aborted'))
      }
      await expect(result).resolves.toEqual({ success: false, cancelled: true })
      expectReleased(sender)
      expect(fake.windows).toHaveLength(0)
      expect(fake.dialog).not.toHaveBeenCalled()
    }
  )

  it('prevents a late load resolution from admitting image or print work', async () => {
    const load = Promise.withResolvers<void>()
    fake.load.mockReturnValueOnce(load.promise)
    const sender = new EventEmitter()
    const result = exportFrom(sender)
    await flush()
    sender.emit('destroyed')
    await flush()
    expectReleased(sender)
    await expect(result).resolves.toEqual({ success: false, cancelled: true })
    load.resolve()
    fake.windows[0]?.events.emit('did-finish-load')
    await flush()
    expectReleased(sender)
    expect(fake.images).not.toHaveBeenCalled()
    expect(fake.print).not.toHaveBeenCalled()
  })

  it('keeps a replacement document and another requester independent of late old work', async () => {
    const images = Promise.withResolvers<void>()
    const otherImages = Promise.withResolvers<void>()
    fake.images.mockReturnValueOnce(images.promise).mockReturnValueOnce(otherImages.promise)
    const sender = new EventEmitter()
    const oldResult = exportFrom(sender)
    await flush()
    const other = new EventEmitter()
    const otherResult = exportFrom(other)
    await flush()
    sender.emit('did-navigate')
    await flush()
    expect(fake.windows.map((window) => window.destroyed)).toEqual([true, false])
    expect(fake.tempFiles.size).toBe(1)
    expect(other.listenerCount('render-process-gone')).toBe(1)
    await expect(oldResult).resolves.toEqual({ success: false, cancelled: true })
    fake.dialog.mockResolvedValueOnce({ canceled: false, filePath: '/chosen/new.pdf' })
    fake.dialog.mockResolvedValueOnce({ canceled: false, filePath: '/chosen/other.pdf' })
    await expect(exportFrom(sender)).resolves.toEqual({
      success: true,
      filePath: '/chosen/new.pdf'
    })
    otherImages.resolve()
    await expect(otherResult).resolves.toEqual({
      success: true,
      filePath: '/chosen/other.pdf'
    })
    images.resolve()
    await flush()
    expect(fake.print).toHaveBeenCalledTimes(2)
    expect(fake.dialog).toHaveBeenCalledTimes(2)
    expect(fake.savedFiles).toEqual(
      new Map([
        ['/chosen/new.pdf', PDF],
        ['/chosen/other.pdf', PDF]
      ])
    )
    expectReleased(sender)
    expectReleased(other)
  })

  it('preserves captured content through tab/file switches and same-document navigation', async () => {
    const images = Promise.withResolvers<void>()
    fake.images.mockReturnValueOnce(images.promise)
    fake.dialog.mockResolvedValueOnce({ canceled: false, filePath: '/chosen/snapshot.pdf' })
    const sender = new EventEmitter()
    const result = exportFrom(sender)
    await flush()
    sender.emit('did-navigate-in-page')
    // Tab/file selection is renderer-local; the captured HTML request remains owned by this document.
    images.resolve()
    await expect(result).resolves.toEqual({ success: true, filePath: '/chosen/snapshot.pdf' })
    expect(fake.savedFiles.get('/chosen/snapshot.pdf')).toBe(PDF)
    expectReleased(sender)
  })

  it('does not write a save choice returned after the requesting document retired', async () => {
    const choice = Promise.withResolvers<{ canceled: boolean; filePath: string }>()
    fake.dialog.mockReturnValueOnce(choice.promise)
    const sender = new EventEmitter()
    const result = exportFrom(sender)
    await flush()
    expect(fake.dialog).toHaveBeenCalledOnce()
    sender.emit('render-process-gone')
    choice.resolve({ canceled: false, filePath: '/chosen/late.pdf' })
    await expect(result).resolves.toEqual({ success: false, cancelled: true })
    expect(fake.savedFiles.size).toBe(0)
    expectReleased(sender)
  })

  it('finishes a user-accepted write that started before retirement', async () => {
    const writing = Promise.withResolvers<void>()
    fake.dialog.mockResolvedValueOnce({ canceled: false, filePath: '/chosen/accepted.pdf' })
    fake.write.mockImplementation(async (path, data) => {
      if (typeof data === 'string') {
        fake.tempFiles.add(path)
        return
      }
      await writing.promise
      fake.savedFiles.set(path, data)
    })
    const sender = new EventEmitter()
    const result = exportFrom(sender)
    await flush()
    expect(fake.write).toHaveBeenCalledWith('/chosen/accepted.pdf', PDF)
    sender.emit('destroyed')
    writing.resolve()
    await expect(result).resolves.toEqual({ success: true, filePath: '/chosen/accepted.pdf' })
    expect(fake.savedFiles.get('/chosen/accepted.pdf')).toBe(PDF)
    expectReleased(sender)
  })

  it('releases listeners and resources across repeated successful and retired exports', async () => {
    const sender = new EventEmitter()
    for (let index = 0; index < 10; index++) {
      const retired = index % 2 === 0
      const filePath = `/chosen/${index}.pdf`
      const images = Promise.withResolvers<void>()
      fake.images.mockReturnValueOnce(images.promise)
      if (!retired) {
        fake.dialog.mockResolvedValueOnce({ canceled: false, filePath })
      }
      const prints = fake.print.mock.calls.length
      const dialogs = fake.dialog.mock.calls.length
      const result = exportFrom(sender)
      await flush()
      if (retired) {
        sender.emit('render-process-gone')
      } else {
        images.resolve()
      }
      await flush()
      expectReleased(sender)
      if (retired) {
        await expect(result).resolves.toEqual({ success: false, cancelled: true })
        expect(fake.print.mock.calls.length).toBe(prints)
        expect(fake.dialog.mock.calls.length).toBe(dialogs)
        expect(fake.savedFiles.has(filePath)).toBe(false)
      } else {
        await expect(result).resolves.toEqual({ success: true, filePath })
        expect(fake.print.mock.calls.length).toBe(prints + 1)
        expect(fake.savedFiles.get(filePath)).toEqual(PDF)
      }
      images.reject(new Error('late image failure'))
      await flush()
      expectReleased(sender)
    }
  })
})
