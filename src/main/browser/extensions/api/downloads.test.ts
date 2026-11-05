import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionCaller } from '../api-runtime/browser-extension-namespace-registry'

const mocks = vi.hoisted(() => {
  const emitted: { event: string; args: unknown[] }[] = []
  return {
    emitted,
    requestDownloadFilename: vi.fn(),
    requestDownloadSavePath: vi.fn(),
    markExtensionDownload: vi.fn(),
    chooseSavePath: vi.fn(async (): Promise<string | null> => null)
  }
})

vi.mock('electron', () => ({ webContents: { fromId: () => undefined } }))
vi.mock('./downloads-save-as', () => ({ chooseDownloadSavePath: mocks.chooseSavePath }))
vi.mock('../../browser-manager', () => ({
  browserManager: {
    getTabIdForWebContentsId: () => 'tab-1',
    requestDownloadFilename: mocks.requestDownloadFilename,
    requestDownloadSavePath: mocks.requestDownloadSavePath,
    markExtensionDownload: mocks.markExtensionDownload
  }
}))
vi.mock('../api-runtime/browser-extension-api-host', () => ({
  emitBrowserExtensionEvent: (_target: unknown, _ns: string, event: string, args: unknown[]) =>
    mocks.emitted.push({ event, args })
}))
vi.mock('../tabs-and-windows/browser-extension-tab-model', () => ({
  getActiveBrowserTabId: () => null
}))

const { registerDownloadsNamespace } = await import('./downloads')
const { getBrowserExtensionNamespace } =
  await import('../api-runtime/browser-extension-namespace-registry')

const EXTENSION_ID = 'a'.repeat(32)
const OTHER_ID = 'b'.repeat(32)
const sessions = new Set<Electron.Session>()
const pendingDownloads: Promise<unknown>[] = []
let nextOwnerId = 7

const { ensureHostSessionState, forgetHostSession, forgetExtensionContexts } =
  await import('../api-runtime/browser-extension-contexts')

function fakeItem(url: string, savePath: string, finalUrl = url) {
  return {
    getURL: () => finalUrl,
    getURLChain: () => (finalUrl === url ? [url] : [url, finalUrl]),
    getState: () => 'progressing',
    getSavePath: () => savePath,
    getMimeType: () => '',
    getStartTime: () => 0,
    isPaused: () => false,
    canResume: () => false,
    getReceivedBytes: () => 0,
    getTotalBytes: () => 0,
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn()
  }
}

function setup() {
  const session = new EventEmitter()
  const owner = { id: nextOwnerId++, isDestroyed: () => false, downloadURL: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: downloads and context lifetime read only these stubbed caller fields.
  const caller = {
    extension: { id: EXTENSION_ID },
    session,
    webContents: owner
  } as unknown as BrowserExtensionCaller
  ensureHostSessionState(caller.session, 'default')
  sessions.add(caller.session)
  const download = (
    options: Record<string, unknown>,
    extensionId = EXTENSION_ID
  ): Promise<unknown> => {
    const pending = Promise.resolve().then(() =>
      getBrowserExtensionNamespace('downloads')?.methods.download.invoke(
        { ...caller, extension: { ...caller.extension, id: extensionId } },
        [options]
      )
    )
    pendingDownloads.push(pending)
    void pending.catch(() => {})
    return pending
  }
  const willDownload = (item: ReturnType<typeof fakeItem>): void => {
    session.emit('will-download', {}, item, owner)
  }
  return { session: caller.session, owner, download, willDownload }
}

function retireContext(session: Electron.Session, kind: 'extension' | 'host'): void {
  if (kind === 'host') {
    forgetHostSession(session)
    ensureHostSessionState(session, 'default')
  } else {
    forgetExtensionContexts(session, EXTENSION_ID)
  }
}

beforeEach(() => {
  mocks.emitted.length = 0
  mocks.requestDownloadFilename.mockReset()
  mocks.requestDownloadSavePath.mockReset()
  mocks.chooseSavePath.mockReset()
  registerDownloadsNamespace()
})

afterEach(async () => {
  if (vi.isFakeTimers()) {
    await vi.runAllTimersAsync()
    vi.useRealTimers()
  }
  await Promise.allSettled(pendingDownloads.splice(0))
  for (const session of sessions) {
    forgetHostSession(session)
  }
  sessions.clear()
})

describe('download context lifetime', () => {
  beforeEach(() => vi.useFakeTimers())

  it.each(['extension', 'host'] as const)(
    'skips obsolete starts after %s retirement without releasing the active native start',
    async (kind) => {
      const { session, owner, download, willDownload } = setup()
      const url = 'https://site.test/serialized'
      const first = download({ url, filename: 'active.txt' })
      const obsolete = [
        download({ url, filename: 'obsolete-1.txt' }),
        download({ url, filename: 'obsolete-2.txt' })
      ]
      let obsoleteResults: PromiseSettledResult<unknown>[] | undefined
      void Promise.allSettled(obsolete).then((results) => {
        obsoleteResults = results
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(owner.downloadURL).toHaveBeenCalledTimes(1)
      retireContext(session, kind)
      const successor = download({ url, filename: 'successor.txt' })
      const sibling = download({ url, filename: 'sibling.txt' }, OTHER_ID)
      await vi.advanceTimersByTimeAsync(0)
      expect(owner.downloadURL).toHaveBeenCalledTimes(1)
      expect(session.listenerCount('will-download')).toBe(1)
      expect(vi.getTimerCount()).toBe(1)

      const activeItem = fakeItem(url, '/downloads/active.txt')
      willDownload(activeItem)
      await expect(first).resolves.toEqual(expect.any(Number))
      await vi.advanceTimersByTimeAsync(0)
      expect(obsoleteResults).toEqual([
        {
          status: 'rejected',
          reason: expect.objectContaining({ message: 'Extension context was unloaded' })
        },
        {
          status: 'rejected',
          reason: expect.objectContaining({ message: 'Extension context was unloaded' })
        }
      ])
      expect(owner.downloadURL).toHaveBeenCalledTimes(2)
      expect(mocks.requestDownloadFilename).toHaveBeenCalledExactlyOnceWith(
        activeItem,
        'active.txt'
      )
      const successorItem = fakeItem(url, '/downloads/successor.txt')
      willDownload(successorItem)
      await expect(successor).resolves.toEqual(expect.any(Number))
      await vi.advanceTimersByTimeAsync(0)
      expect(owner.downloadURL).toHaveBeenCalledTimes(3)
      const siblingItem = fakeItem(url, '/downloads/sibling.txt')
      willDownload(siblingItem)
      await expect(sibling).resolves.toEqual(expect.any(Number))
      expect(mocks.requestDownloadFilename.mock.calls.map(([, name]) => name)).toEqual([
        'active.txt',
        'successor.txt',
        'sibling.txt'
      ])
      expect(session.listenerCount('will-download')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['extension', 'host'] as const)(
    'rejects a late save dialog result after %s retirement before waiting behind a live start',
    async (kind) => {
      const { session, owner, download, willDownload } = setup()
      const dialog = Promise.withResolvers<string | null>()
      mocks.chooseSavePath.mockReturnValueOnce(dialog.promise)
      const url = 'https://site.test/save-as'
      const old = download({ url, saveAs: true })
      let oldSettled = false
      void old
        .finally(() => {
          oldSettled = true
        })
        .catch(() => {})
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.chooseSavePath).toHaveBeenCalledOnce()
      retireContext(session, kind)
      const successor = download({ url, filename: 'live.txt' })
      await vi.advanceTimersByTimeAsync(0)
      expect(owner.downloadURL).toHaveBeenCalledTimes(1)
      dialog.resolve('/downloads/obsolete.txt')
      await vi.advanceTimersByTimeAsync(0)
      expect(oldSettled).toBe(true)
      await expect(old).rejects.toThrow('Extension context was unloaded')
      expect(owner.downloadURL).toHaveBeenCalledTimes(1)
      expect(mocks.requestDownloadSavePath).not.toHaveBeenCalled()
      willDownload(fakeItem(url, '/downloads/live.txt'))
      await expect(successor).resolves.toEqual(expect.any(Number))
      expect(session.listenerCount('will-download')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('skips obsolete starts after the admitted predecessor times out', async () => {
    const { session, owner, download, willDownload } = setup()
    const url = 'https://site.test/timeout'
    const first = download({ url })
    const obsolete = download({ url })
    let obsoleteResult: unknown
    void obsolete.catch((error: unknown) => {
      obsoleteResult = error
    })
    await vi.advanceTimersByTimeAsync(0)
    retireContext(session, 'extension')
    const successor = download({ url })
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(first).rejects.toThrow('The download did not start')
    expect(obsoleteResult).toEqual(
      expect.objectContaining({ message: 'Extension context was unloaded' })
    )
    await expect(obsolete).rejects.toThrow('Extension context was unloaded')
    expect(owner.downloadURL).toHaveBeenCalledTimes(2)
    expect(session.listenerCount('will-download')).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    willDownload(fakeItem(url, '/downloads/live.txt'))
    await expect(successor).resolves.toEqual(expect.any(Number))
    expect(session.listenerCount('will-download')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
