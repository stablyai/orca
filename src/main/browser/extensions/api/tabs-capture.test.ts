import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

vi.mock('electron', () => ({ webFrameMain: { fromId: vi.fn() } }))

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
const { ensureHostSessionState, forgetExtensionContexts, forgetHostSession } =
  await import('../browser-extension-contexts')

const EXTENSION_ID = 'a'.repeat(32)

function fakeImage(empty = false) {
  return {
    isEmpty: () => empty,
    toPNG: vi.fn(() => Buffer.from('png-bytes')),
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

const QUOTA_ERROR = 'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'
let caller: BrowserExtensionCaller

function createCaller(): BrowserExtensionCaller {
  const stub = {
    extension: { id: EXTENSION_ID, manifest: {} },
    session: {},
    browserProfileId: 'default'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture and context ownership read only the extension/session/profile fields stubbed above.
  const created = stub as unknown as BrowserExtensionCaller
  ensureHostSessionState(created.session, created.browserProfileId)
  return created
}

function captureAs(overrides: Partial<BrowserExtensionCaller>, ...args: unknown[]) {
  return new Promise((resolve) =>
    resolve(captureVisibleTabMethod.invoke({ ...caller, ...overrides }, args))
  )
}

function capture(...args: unknown[]) {
  return captureAs({}, ...args)
}

beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0)
  caller = createCaller()
  mocks.tabs = []
  mocks.windows = new Set([1, 2])
  mocks.hostPatterns = []
  mocks.activeTabGrants = new Set()
  mocks.holdPaint.mockClear().mockReturnValue(mocks.releasePaint)
  mocks.releasePaint.mockClear()
})

afterEach(() => {
  forgetHostSession(caller.session)
  vi.restoreAllMocks()
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

  it('admits two mixed-window captures before native work starts and rejects the rest', async () => {
    mocks.hostPatterns = ['<all_urls>']
    const image = fakeImage()
    const deferred = Promise.withResolvers<ReturnType<typeof fakeImage>>()
    const capturePage = vi.fn(() => deferred.promise)
    mocks.tabs = [1, 2].map((windowId) => ({
      windowId,
      active: true,
      contents: { id: windowId, getURL: () => 'https://site.test/', capturePage }
    }))
    const pending = Array.from({ length: 40 }, (_, index) =>
      capture(index % 2 ? 2 : 1, { format: index % 2 ? 'png' : 'jpeg' })
    )
    const completed = Promise.allSettled(pending)
    const nativeCallsBeforeCompletion = capturePage.mock.calls.length
    expect(image.toPNG).not.toHaveBeenCalled()
    expect(image.toJPEG).not.toHaveBeenCalled()
    deferred.resolve(image)
    const results = await completed
    expect(nativeCallsBeforeCompletion).toBe(2)
    expect(mocks.holdPaint).toHaveBeenCalledTimes(2)
    expect(mocks.releasePaint).toHaveBeenCalledTimes(2)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(38)
    for (const result of results.slice(2)) {
      if (result.status === 'rejected') {
        expect(result.reason).toHaveProperty('message', QUOTA_ERROR)
      }
    }
    expect(image.toPNG).toHaveBeenCalledTimes(1)
    expect(image.toJPEG).toHaveBeenCalledTimes(1)
  })

  it('shares page/worker admission but isolates extension and session identities', async () => {
    mocks.hostPatterns = ['<all_urls>']
    const active = tab(7, 'https://site.test/')
    mocks.tabs = [active]
    await capture()
    await captureAs({ fromWorker: true })
    await expect(capture()).rejects.toThrow(QUOTA_ERROR)
    await expect(captureAs({ fromWorker: true })).rejects.toThrow(QUOTA_ERROR)
    const extension = { ...caller.extension, id: 'b'.repeat(32) }
    await captureAs({ extension })
    await captureAs({ extension, fromWorker: true })
    await expect(captureAs({ extension })).rejects.toThrow(QUOTA_ERROR)
    const separate = createCaller()
    try {
      await captureAs(separate)
      await captureAs({ ...separate, fromWorker: true })
      await expect(captureAs(separate)).rejects.toThrow(QUOTA_ERROR)
    } finally {
      forgetHostSession(separate.session)
    }
    expect(active.contents.capturePage).toHaveBeenCalledTimes(6)
  })

  it('resets the fixed window only after its deadline, independent of the second call', async () => {
    mocks.hostPatterns = ['<all_urls>']
    mocks.tabs = [tab(7, 'https://site.test/')]
    const clock = vi.mocked(performance.now)
    await capture()
    clock.mockReturnValue(800)
    await capture()
    clock.mockReturnValue(1_000)
    await expect(capture()).rejects.toThrow(QUOTA_ERROR)
    clock.mockReturnValue(1_000.001)
    await capture()
    await capture()
    await expect(capture()).rejects.toThrow(QUOTA_ERROR)
  })

  it('exempts trusted user gestures without spending or refilling ordinary admission', async () => {
    mocks.hostPatterns = ['<all_urls>']
    const active = tab(7, 'https://site.test/')
    mocks.tabs = [active]
    for (let count = 0; count < 5; count++) {
      await captureAs({ userGesture: true })
    }
    await capture()
    await capture()
    await expect(capture({ userGesture: true })).rejects.toThrow(QUOTA_ERROR)
    await captureAs({ userGesture: true })
    await expect(capture()).rejects.toThrow(QUOTA_ERROR)
    expect(active.contents.capturePage).toHaveBeenCalledTimes(8)
  })

  it('preserves pre-capture failures without charging admission', async () => {
    mocks.tabs = [tab(7, 'https://site.test/')]
    await expect(capture()).rejects.toThrow('permission is required')
    mocks.hostPatterns = ['<all_urls>']
    await expect(capture({ quality: 101 })).rejects.toThrow('Invalid arguments')
    await expect(capture(99)).rejects.toThrow('No window with id: 99.')
    await capture()
    await capture()
    await expect(capture()).rejects.toThrow(QUOTA_ERROR)
  })

  it('charges failed native work and recovers after the window expires', async () => {
    mocks.hostPatterns = ['<all_urls>']
    const clock = vi.mocked(performance.now)
    const image = fakeImage(true)
    const active = tab(7, 'https://site.test/', 1, image)
    mocks.tabs = [active]
    active.contents.capturePage.mockRejectedValueOnce(new Error('native capture rejected'))
    await expect(capture()).rejects.toThrow('native capture rejected')
    await expect(capture()).rejects.toThrow('Internal error while trying to capture')
    await expect(capture()).rejects.toThrow(QUOTA_ERROR)
    expect(active.contents.capturePage).toHaveBeenCalledTimes(2)
    expect(image.toJPEG).not.toHaveBeenCalled()
    clock.mockReturnValue(1_000.001)
    mocks.tabs = [tab(8, 'https://site.test/')]
    await expect(capture()).resolves.toMatch(/^data:image\/jpeg;base64,/)
  })

  it('renews admission after extension unload and host replacement', async () => {
    mocks.hostPatterns = ['<all_urls>']
    mocks.tabs = [tab(7, 'https://site.test/')]
    await capture()
    await captureAs({ fromWorker: true })
    await expect(capture()).rejects.toThrow(QUOTA_ERROR)
    forgetExtensionContexts(caller.session, EXTENSION_ID)
    await captureAs({ fromWorker: true })
    await capture()
    await expect(capture()).rejects.toThrow(QUOTA_ERROR)
    forgetHostSession(caller.session)
    await expect(capture()).rejects.toThrow('Not an extension context')
    ensureHostSessionState(caller.session, 'replacement')
    await capture()
    await captureAs({ fromWorker: true })
    await expect(capture()).rejects.toThrow(QUOTA_ERROR)
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
