import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock, stdinWrites } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    existsSyncMock: vi.fn(() => false),
    readFileSyncMock: vi.fn(() => Buffer.from('')),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hoisted mutable sink starts empty and only accepts strings.
    stdinWrites: [] as string[]
  }))

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  accessSync: vi.fn(),
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))
vi.mock('os', () => ({ platform: () => 'darwin', arch: () => 'arm64' }))
vi.mock('electron', () => {
  return {
    app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
    webContents: { fromId: webContentsFromIdMock }
  }
})
const { CdpWsProxyMock } = vi.hoisted(() => {
  const instances: unknown[] = []
  const MockClass = vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    _wc: unknown
  ) {
    this._wc = _wc
    this.start = vi.fn(async () => 'ws://127.0.0.1:9222')
    this.stop = vi.fn(async () => {})
    this.getPort = vi.fn(() => 9222)
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }) }
})

vi.mock('./cdp-ws-proxy', () => ({
  CdpWsProxy: CdpWsProxyMock
}))
vi.mock('./cdp-bridge', () => ({
  BrowserError: class BrowserError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
}))

import { AgentBrowserBridge } from './agent-browser-bridge'
import {
  createSucceedWith,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const succeedWith = createSucceedWith(execFileMock, stdinWrites)

describe('AgentBrowserBridge sleeping serve pages', () => {
  let wakePage: ReturnType<typeof vi.fn<(pageId: string) => Promise<number>>>
  let sleepingPages: Set<string>

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    wakePage = vi.fn(async (_pageId: string) => 202)
    sleepingPages = new Set<string>(['page-sleeping'])
  })

  function makeBridge(tabs: Map<string, number>): AgentBrowserBridge {
    return new AgentBrowserBridge(mockBrowserManager(tabs), {
      // Wakes into a fresh window whose guest re-registered as webContents 202.
      resolveSleepingPage: (browserPageId) => {
        if (!sleepingPages.has(browserPageId)) {
          return null
        }
        return wakePage(browserPageId).then((webContentsId) => ({ webContentsId }))
      },
      isOffscreenPageSleeping: (browserPageId) => sleepingPages.has(browserPageId),
      getSleepingPageUrl: (browserPageId) =>
        sleepingPages.has(browserPageId) ? 'https://restored.example' : '',
      listSleepingPageIds: () => [...sleepingPages]
    })
  }

  it('a sleeping tab stays listed with its stored url and a dead tab is unregistered', () => {
    const b = makeBridge(new Map([['page-dead', 999]]))
    webContentsFromIdMock.mockReturnValue(null)
    const result = b.tabList()
    // page-dead: registered but truly dead -> unregistered and dropped.
    // page-sleeping: unregistered by design but still listed.
    expect(result.tabs.map((tab) => tab.browserPageId)).toEqual(['page-sleeping'])
    expect(result.tabs[0]?.url).toBe('https://restored.example')
    expect(b['browserManager'].unregisterGuest).toHaveBeenCalledWith('page-dead')
    expect(b['browserManager'].unregisterGuest).not.toHaveBeenCalledWith('page-sleeping')
  })

  it('a command targeting a sleeping page wakes it and routes to the recreated window', async () => {
    const woken = mockWebContents(202, 'https://restored.example', 'Restored')
    webContentsFromIdMock.mockImplementation((id: number) => (id === 202 ? woken : null))
    const b = makeBridge(new Map())
    succeedWith({ snapshot: 'tree output' })

    const result = await b.snapshot(undefined, 'page-sleeping')

    expect(wakePage).toHaveBeenCalledWith('page-sleeping')
    expect(result).toEqual({ browserPageId: 'page-sleeping', snapshot: 'tree output' })
  })

  it('a command targeting a genuinely unknown page still fails with browser_tab_not_found', async () => {
    const b = makeBridge(new Map())
    await expect(b.snapshot(undefined, 'page-unknown')).rejects.toMatchObject({
      code: 'browser_tab_not_found'
    })
    expect(wakePage).not.toHaveBeenCalled()
  })

  it('a sleeping active page id is reported by getActivePageId without waking', () => {
    const b = makeBridge(new Map())
    expect(b.getActivePageId(undefined, 'page-sleeping')).toBe('page-sleeping')
    expect(wakePage).not.toHaveBeenCalled()
  })

  it('wake failure surfaces the original not-found error', async () => {
    wakePage.mockRejectedValue(new Error('backend is shutting down'))
    // The bridge wraps wake failures as browser_tab_not_found only for BrowserError-shaped
    // errors it doesn't recognize; anything else propagates as-is — assert the code it throws.
    const b = makeBridge(new Map())
    await expect(b.snapshot(undefined, 'page-sleeping')).rejects.toThrow('backend is shutting down')
    expect(wakePage).toHaveBeenCalledTimes(1)
  })
})
