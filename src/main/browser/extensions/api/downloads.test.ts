import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionCaller } from '../browser-extension-namespace-registry'

const mocks = vi.hoisted(() => {
  const emitted: { event: string; args: unknown[] }[] = []
  return { emitted, requestDownloadFilename: vi.fn() }
})

vi.mock('electron', () => ({ webContents: { fromId: () => undefined } }))
vi.mock('../../browser-manager', () => ({
  browserManager: {
    getTabIdForWebContentsId: () => 'tab-1',
    requestDownloadFilename: mocks.requestDownloadFilename
  }
}))
vi.mock('../browser-extension-api-host', () => ({
  emitBrowserExtensionEvent: (_target: unknown, _ns: string, event: string, args: unknown[]) =>
    mocks.emitted.push({ event, args })
}))
vi.mock('../browser-extension-tab-model', () => ({ getActiveBrowserTabId: () => null }))

const { registerDownloadsNamespace } = await import('./downloads')
const { getBrowserExtensionNamespace } = await import('../browser-extension-namespace-registry')

const EXTENSION_ID = 'a'.repeat(32)

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
  const owner = { id: 7, isDestroyed: () => false, downloadURL: vi.fn() }
  const caller = { extension: { id: EXTENSION_ID }, session, webContents: owner }
  const download = (options: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve().then(() =>
      getBrowserExtensionNamespace('downloads')?.methods.download.invoke(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: downloads reads only the caller fields stubbed above.
        caller as unknown as BrowserExtensionCaller,
        [options]
      )
    )
  const willDownload = (item: ReturnType<typeof fakeItem>): void => {
    session.emit('will-download', {}, item, owner)
  }
  return { session, owner, download, willDownload }
}

beforeEach(() => {
  mocks.emitted.length = 0
  mocks.requestDownloadFilename.mockReset()
  registerDownloadsNamespace()
})

describe('downloads.download', () => {
  it("accepts the extension's own pages, relative or absolute, and refuses another extension's", async () => {
    const { owner, download, willDownload } = setup()
    const own = `chrome-extension://${EXTENSION_ID}/export.json`
    const pending = download({ url: 'export.json' })
    await vi.waitFor(() => expect(owner.downloadURL).toHaveBeenCalledWith(own, { headers: {} }))
    willDownload(fakeItem(own, '/downloads/export.json'))
    await expect(pending).resolves.toEqual(expect.any(Number))

    await expect(download({ url: `chrome-extension://${'b'.repeat(32)}/x.json` })).rejects.toThrow(
      'Invalid URL'
    )
  })

  it('gives concurrent identical downloads one native item each', async () => {
    const { owner, download, willDownload } = setup()
    const url = 'https://site.test/file.zip'
    const first = download({ url })
    const second = download({ url })
    await vi.waitFor(() => expect(owner.downloadURL).toHaveBeenCalledTimes(1))
    const itemA = fakeItem(url, '/downloads/file.zip')
    willDownload(itemA)
    await vi.waitFor(() => expect(owner.downloadURL).toHaveBeenCalledTimes(2))
    const itemB = fakeItem(url, '/downloads/file (1).zip')
    willDownload(itemB)

    const ids = await Promise.all([first, second])
    expect(new Set(ids).size).toBe(2)
    expect(itemA.once).toHaveBeenCalledTimes(1)
    expect(itemB.once).toHaveBeenCalledTimes(1)
    expect(mocks.emitted.filter(({ event }) => event === 'onCreated')).toEqual([
      { event: 'onCreated', args: [expect.objectContaining({ filename: '/downloads/file.zip' })] },
      {
        event: 'onCreated',
        args: [expect.objectContaining({ filename: '/downloads/file (1).zip' })]
      }
    ])
  })

  it('names the item before the download manager reserves its destination', async () => {
    const { session, owner, download, willDownload } = setup()
    const order: string[] = []
    session.on('will-download', () => order.push('manager'))
    mocks.requestDownloadFilename.mockImplementation(() => order.push('filename'))
    const url = 'https://site.test/file'
    const pending = download({ url, filename: 'reports/q3.csv', saveAs: false })
    await vi.waitFor(() => expect(owner.downloadURL).toHaveBeenCalled())
    const item = fakeItem(url, '/downloads/q3.csv')
    willDownload(item)
    await pending

    expect(mocks.requestDownloadFilename).toHaveBeenCalledWith(item, 'reports/q3.csv')
    expect(order).toEqual(['filename', 'manager'])
  })

  it('matches a redirected download by the URL it requested', async () => {
    const { owner, download, willDownload } = setup()
    const url = 'https://site.test/export'
    const pending = download({ url, filename: 'export.csv' })
    await vi.waitFor(() => expect(owner.downloadURL).toHaveBeenCalled())
    const item = fakeItem(url, '/downloads/export.csv', 'https://cdn.test/a1b2')
    willDownload(item)

    await expect(pending).resolves.toEqual(expect.any(Number))
    expect(mocks.requestDownloadFilename).toHaveBeenCalledWith(item, 'export.csv')
    expect(mocks.emitted).toContainEqual({
      event: 'onCreated',
      args: [expect.objectContaining({ url, finalUrl: 'https://cdn.test/a1b2' })]
    })
  })

  it.each([
    [{ filename: '../escape.txt' }, 'Invalid filename'],
    [{ filename: '/etc/passwd' }, 'Invalid filename'],
    [{ filename: 'C:\\x.txt' }, 'Invalid filename'],
    [{ saveAs: true }, 'Orca cannot ask where to save a download'],
    [{ conflictAction: 'overwrite' }, 'conflictAction']
  ])('rejects options it cannot honour: %j', async (options, message) => {
    const { owner, download } = setup()
    await expect(download({ url: 'https://site.test/f', ...options })).rejects.toThrow(message)
    expect(owner.downloadURL).not.toHaveBeenCalled()
  })
})
