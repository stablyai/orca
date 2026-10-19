import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DragTempFileCopy from './dragged-temp-file-copy'
import type { DragTempCopyItemResult } from './dragged-temp-file-copy'

type IpcListener = (event: { sender: unknown }, payload: unknown) => void
type InvokeHandler = (event: { sender: unknown }, payload: unknown) => Promise<unknown>

const { materializeMock, sweepMock, ipcListeners, ipcHandlers } = vi.hoisted(() => ({
  materializeMock: vi.fn(),
  sweepMock: vi.fn(),
  ipcListeners: new Map<string, IpcListener>(),
  ipcHandlers: new Map<string, InvokeHandler>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/app-temp' },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => ipcHandlers.set(channel, handler),
    removeHandler: (channel: string) => ipcHandlers.delete(channel),
    on: (channel: string, listener: IpcListener) => ipcListeners.set(channel, listener),
    removeListener: (channel: string, listener: IpcListener) => {
      if (ipcListeners.get(channel) === listener) {
        ipcListeners.delete(channel)
      }
    },
    removeAllListeners: (channel: string) => ipcListeners.delete(channel)
  }
}))

vi.mock('./dragged-temp-file-copy', async (importOriginal) => ({
  ...(await importOriginal<typeof DragTempFileCopy>()),
  materializeDragTempPaths: materializeMock,
  scheduleDragTempCopySweep: sweepMock
}))

vi.mock('./darwin-user-temp-dir', () => ({
  getDarwinUserTempDir: async () => '/private/var/folders/ab/xyz/T'
}))

import { registerDroppedPathPreparation } from './dropped-path-preparation-ipc'

const DRAG_TEMP = join('/', 'var', 'T', 'TemporaryItems', 'NSIRD_screencaptureui_1', 'Shot.png')
const COPY = join('/', 'var', 'T', 'orca-drops-501', 'orca-drop-abc123', 'Shot.png')
const FINDER = join('/', 'Users', 'me', 'Desktop', 'notes.txt')

function copied(sourcePath: string, destPath = sourcePath): DragTempCopyItemResult {
  return { sourcePath, status: 'imported', destPath }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  materializeMock.mockReset()
})

function createWindow() {
  let destroyed = false
  const windowListeners = new Map<string, () => void>()
  const webContents = {
    isDestroyed: () => destroyed,
    send: vi.fn(),
    once: vi.fn<(event: string, listener: () => void) => void>(),
    removeListener: vi.fn()
  }
  const fake = {
    isDestroyed: () => destroyed,
    on: (event: string, listener: () => void) => windowListeners.set(event, listener),
    webContents
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preparation handler only touches the members stubbed above.
  const window = fake as unknown as BrowserWindow
  return {
    window,
    webContents,
    close: () => {
      destroyed = true
      windowListeners.get('closed')?.()
    },
    destroy: () => {
      destroyed = true
      webContents.once.mock.calls.find(([event]) => event === 'destroyed')?.[1]()
    }
  }
}

describe('registerDroppedPathPreparation', () => {
  beforeEach(() => {
    ipcListeners.clear()
    ipcHandlers.clear()
    sweepMock.mockReset()
  })

  it('registers only the preparation request and starts copy expiry', () => {
    const { window } = createWindow()
    registerDroppedPathPreparation(window)
    expect([...ipcHandlers.keys()]).toEqual(['fs:prepareDroppedPaths'])
    expect(ipcListeners.size).toBe(0)
    expect(sweepMock).toHaveBeenCalledOnce()
  })

  it('prepares ordinary paths only for its own live renderer and validates the request', async () => {
    const { window, webContents, close } = createWindow()
    registerDroppedPathPreparation(window)
    const handler = ipcHandlers.get('fs:prepareDroppedPaths')!
    const request = { paths: [FINDER], consumer: 'agent' }
    expect(() => handler({ sender: {} }, request)).toThrow('owning window')
    for (const invalid of [
      null,
      { paths: [FINDER], consumer: 'other' },
      { paths: [42], consumer: 'agent' }
    ]) {
      expect(() => handler({ sender: webContents }, invalid)).toThrow('Invalid')
    }
    await expect(handler({ sender: webContents }, request)).resolves.toEqual({
      paths: [FINDER],
      failures: []
    })
    expect(webContents.send).not.toHaveBeenCalled()
    close()
    expect(ipcHandlers.has('fs:prepareDroppedPaths')).toBe(false)
    expect(() => handler({ sender: webContents }, request)).toThrow('owning window')
  })

  it('enforces both request caps before preparing any paths', async () => {
    const { window, webContents } = createWindow()
    registerDroppedPathPreparation(window)
    const handler = ipcHandlers.get('fs:prepareDroppedPaths')!
    await expect(
      handler(
        { sender: webContents },
        { paths: Array.from({ length: 257 }, () => DRAG_TEMP), consumer: 'agent' }
      )
    ).resolves.toMatchObject({
      paths: [],
      failures: [{ reason: 'too-many-paths', pathCount: 257 }]
    })
    await expect(
      handler({ sender: webContents }, { paths: ['x'.repeat(256 * 1024 + 1)], consumer: 'agent' })
    ).resolves.toMatchObject({ paths: [], failures: [{ reason: 'paths-too-large' }] })
    expect(materializeMock).not.toHaveBeenCalled()
  })

  it('keeps the replacement window handler when an older window closes late', async () => {
    const first = createWindow()
    const second = createWindow()
    registerDroppedPathPreparation(first.window)
    registerDroppedPathPreparation(second.window)
    const handler = ipcHandlers.get('fs:prepareDroppedPaths')!
    first.close()
    expect(ipcHandlers.get('fs:prepareDroppedPaths')).toBe(handler)
    await expect(
      handler({ sender: second.webContents }, { paths: [FINDER], consumer: 'main-reader' })
    ).resolves.toEqual({ paths: [FINDER], failures: [] })
  })

  it.skipIf(process.platform !== 'darwin')(
    'copies from the macOS user temp dir and aborts when the renderer is gone',
    async () => {
      const copy = deferred<DragTempCopyItemResult[]>()
      materializeMock.mockReturnValueOnce(copy.promise)
      const { window, webContents, destroy } = createWindow()
      registerDroppedPathPreparation(window)
      const handler = ipcHandlers.get('fs:prepareDroppedPaths')!
      const pending = handler({ sender: webContents }, { paths: [DRAG_TEMP], consumer: 'agent' })
      await settle()
      expect(materializeMock.mock.calls[0][1]).toMatchObject({
        platform: 'darwin',
        sourceTempRoot: '/private/var/folders/ab/xyz/T'
      })
      const signal = materializeMock.mock.calls[0][2]
      expect(signal).toBeInstanceOf(AbortSignal)
      const rejected = expect(pending).rejects.toThrow('went away')
      destroy()
      copy.resolve([copied(DRAG_TEMP, COPY)])
      await rejected
      expect(signal.aborted).toBe(true)
      expect(webContents.send).not.toHaveBeenCalled()
    }
  )
})
