import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionCaller } from '../browser-extension-namespace-registry'

const mocks = vi.hoisted(() => {
  const tabs: { windowId: number; active: boolean; contents: unknown }[] = []
  const hostPatterns: string[] = []
  return {
    tabs,
    windows: new Set<number>(),
    hostPatterns,
    activeTabGrants: new Set<number>(),
    releasePaint: vi.fn(),
    holdPaint: vi.fn()
  }
})

vi.mock('../../browser-manager', () => ({
  browserManager: { holdPaintForCapture: mocks.holdPaint }
}))

vi.mock('../browser-extension-tab-model', () => ({
  listBrowserExtensionTabs: () => mocks.tabs,
  resolveCallerWindowId: () => 1
}))
vi.mock('../browser-extension-window-model', () => ({
  WINDOW_ID_CURRENT: -2,
  getBrowserExtensionWindow: (id: number) => (mocks.windows.has(id) ? {} : null)
}))
vi.mock('./permissions', () => ({
  browserExtensionHostPatternsInSession: () => mocks.hostPatterns
}))
vi.mock('../browser-extension-active-tab', () => ({
  hasBrowserExtensionActiveTab: (_extensionId: string, tabId: number) =>
    mocks.activeTabGrants.has(tabId)
}))

const { captureVisibleTabMethod } = await import('./tabs-capture')

const EXTENSION_ID = 'a'.repeat(32)

function fakeImage(empty = false) {
  return {
    isEmpty: () => empty,
    toPNG: () => Buffer.from('png-bytes'),
    toJPEG: vi.fn((quality: number) => Buffer.from(`jpeg-${quality}`))
  }
}

function tab(id: number, url: string, windowId = 1, image = fakeImage()) {
  return {
    windowId,
    active: true,
    contents: { id, getURL: () => url, capturePage: vi.fn(async () => image) },
    image
  }
}

function capture(...args: unknown[]) {
  const caller = {
    extension: { id: EXTENSION_ID, manifest: {} },
    session: {},
    browserProfileId: 'default'
  }
  return new Promise((resolve) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only the caller fields stubbed above.
    resolve(captureVisibleTabMethod.invoke(caller as unknown as BrowserExtensionCaller, args))
  )
}

beforeEach(() => {
  mocks.tabs = []
  mocks.windows = new Set([1, 2])
  mocks.hostPatterns = []
  mocks.activeTabGrants = new Set()
  mocks.holdPaint.mockClear().mockReturnValue(mocks.releasePaint)
  mocks.releasePaint.mockClear()
})

describe('tabs.captureVisibleTab', () => {
  it("needs <all_urls> or an activeTab grant for the window's active tab", async () => {
    mocks.tabs = [tab(7, 'https://site.test/')]
    mocks.hostPatterns = ['https://*/*']
    await expect(capture()).rejects.toThrow(
      "Either the '<all_urls>' or 'activeTab' permission is required."
    )
    mocks.activeTabGrants.add(7)
    await expect(capture()).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from('jpeg-90').toString('base64')}`
    )
    mocks.activeTabGrants.clear()
    mocks.hostPatterns = ['<all_urls>']
    await expect(capture(null, { format: 'png' })).resolves.toBe(
      `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`
    )
  })

  it('takes options alone or after a window id, with quality for JPEG only', async () => {
    mocks.hostPatterns = ['<all_urls>']
    const other = tab(9, 'https://other.test/', 2)
    mocks.tabs = [tab(7, 'https://site.test/'), other]
    await expect(capture({ format: 'jpeg', quality: 40 })).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from('jpeg-40').toString('base64')}`
    )
    await capture(2, { quality: 10 })
    expect(other.image.toJPEG).toHaveBeenCalledWith(10)
    await expect(capture(5)).rejects.toThrow('No window with id: 5.')
    await expect(capture({ quality: 101 })).rejects.toThrow('Invalid arguments')
  })

  it("refuses another extension's pages, the store and empty captures", async () => {
    mocks.hostPatterns = ['<all_urls>']
    mocks.tabs = [tab(7, `chrome-extension://${'b'.repeat(32)}/page.html`)]
    await expect(capture()).rejects.toThrow(
      'Cannot access a chrome-extension:// URL of different extension'
    )
    mocks.tabs = [tab(7, 'https://chromewebstore.google.com/detail/x')]
    await expect(capture()).rejects.toThrow('The extensions gallery cannot be scripted.')
    mocks.tabs = [tab(7, 'https://site.test/', 1, fakeImage(true))]
    await expect(capture()).rejects.toThrow('Internal error while trying to capture')
    mocks.tabs = []
    await expect(capture()).rejects.toThrow('No active web contents to capture')
  })

  it('releases hidden-page paint when capture fails', async () => {
    mocks.hostPatterns = ['<all_urls>']
    const active = tab(7, 'https://site.test/')
    active.contents.capturePage.mockRejectedValueOnce(new Error('capture failed'))
    mocks.tabs = [active]

    await expect(capture()).rejects.toThrow('capture failed')

    expect(mocks.holdPaint).toHaveBeenCalledWith(7)
    expect(mocks.releasePaint).toHaveBeenCalledTimes(1)
  })
})
