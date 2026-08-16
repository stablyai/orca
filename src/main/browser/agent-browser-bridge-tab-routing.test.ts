import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock, stdinWrites } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    existsSyncMock: vi.fn(() => false),
    readFileSyncMock: vi.fn(() => Buffer.from('')),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockClass = vi.fn().mockImplementation(function (this: any, _wc: unknown) {
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
  resetAgentBrowserBridgeMocks,
  type ExecFileCallback
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const succeedWith = createSucceedWith(execFileMock, stdinWrites)

describe('AgentBrowserBridge', () => {
  let bridge: AgentBrowserBridge

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  it('routes snapshot to an explicit browser page id without changing the active tab', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const wc1 = mockWebContents(1, 'https://a.com', 'A')
    const wc2 = mockWebContents(2, 'https://b.com', 'B')
    webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(1)

    succeedWith({ snapshot: 'tree output' })
    const result = await b.snapshot(undefined, 'tab-b')

    const snapshotCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect(snapshotCall).toBeTruthy()
    expect(snapshotCall![1]).toContain('--session')
    expect(
      (snapshotCall![1] as string[])[(snapshotCall![1] as string[]).indexOf('--session') + 1]
    ).toBe('orca-tab-tab-b')
    expect(result).toEqual({ browserPageId: 'tab-b', snapshot: 'tree output' })
    expect(b.getActiveWebContentsId()).toBe(1)
  })

  // ── Worktree filtering ──

  describe('worktree filtering', () => {
    it('returns all tabs when no worktreeId', () => {
      const tabs = new Map([
        ['tab-a', 1],
        ['tab-b', 2]
      ])
      const b = new AgentBrowserBridge(mockBrowserManager(tabs))
      const result = b.tabList()
      expect(result.tabs).toHaveLength(2)
    })

    it('returns only matching worktree tabs', () => {
      const tabs = new Map([
        ['tab-a', 1],
        ['tab-b', 2]
      ])
      const worktrees = new Map([
        ['tab-a', 'wt-1'],
        ['tab-b', 'wt-2']
      ])
      const wc1 = mockWebContents(1, 'https://a.com', 'A')
      const wc2 = mockWebContents(2, 'https://b.com', 'B')
      webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

      const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
      const result = b.tabList('wt-1')
      expect(result.tabs).toHaveLength(1)
      expect(result.tabs[0].browserPageId).toBe('tab-a')
      expect(result.tabs[0].url).toBe('https://a.com')
    })

    it('surfaces the browser-manager load error on each listed tab', () => {
      const tabs = new Map([['tab-a', 1]])
      const wc1 = mockWebContents(1, 'chrome-error://chromewebdata/', '')
      webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : null))
      const loadError = {
        code: -202,
        description: 'ERR_CERT_AUTHORITY_INVALID',
        validatedUrl: 'https://localhost:3443/'
      }
      const certificateFailure = {
        challengeId: 'challenge-1',
        browserPageId: 'tab-a',
        errorCode: -202,
        error: 'ERR_CERT_AUTHORITY_INVALID',
        origin: 'https://localhost:3443',
        displayHost: 'localhost:3443',
        canProceed: true,
        observedAt: 123
      }
      const b = new AgentBrowserBridge(
        mockBrowserManager(tabs, new Map(), {
          getBrowserPageLoadError: vi.fn((tabId: string) => (tabId === 'tab-a' ? loadError : null)),
          getBrowserPageCertificateFailure: vi.fn((tabId: string) =>
            tabId === 'tab-a' ? certificateFailure : null
          )
        })
      )

      // Why: an agent driving the browser must see the structured cert failure,
      // not just chrome-error:// from getURL().
      expect(b.tabList().tabs[0]).toMatchObject({
        url: 'https://localhost:3443/',
        loadError,
        certificateFailure
      })
    })

    it('does not mutate active-tab routing when tab-list infers the first live tab', () => {
      const tabs = new Map([
        ['tab-a', 1],
        ['tab-b', 2]
      ])
      const wc1 = mockWebContents(1, 'https://a.com', 'A')
      const wc2 = mockWebContents(2, 'https://b.com', 'B')
      webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

      const b = new AgentBrowserBridge(mockBrowserManager(tabs))

      const result = b.tabList()
      expect(result.tabs).toMatchObject([
        { browserPageId: 'tab-a', active: true },
        { browserPageId: 'tab-b', active: false }
      ])
      expect(b.getActiveWebContentsId()).toBeNull()
    })

    it('unregisters stale tab-list entries when their WebContents is gone', () => {
      const tabs = new Map([
        ['tab-a', 1],
        ['tab-b', 2]
      ])
      const wc2 = mockWebContents(2, 'https://b.com', 'B')
      webContentsFromIdMock.mockImplementation((id: number) => (id === 2 ? wc2 : null))
      const unregisterGuest = vi.fn()

      const b = new AgentBrowserBridge(mockBrowserManager(tabs, new Map(), { unregisterGuest }))

      expect(b.tabList().tabs).toMatchObject([{ browserPageId: 'tab-b', active: true }])
      expect(unregisterGuest).toHaveBeenCalledWith('tab-a')
    })
  })

  // ── Tab switch ──

  it('throws on out-of-range tab index', async () => {
    await expect(bridge.tabSwitch(99)).rejects.toThrow('Tab index 99 out of range')
  })

  // ── No tab error ──

  it('throws browser_no_tab when no tabs registered', async () => {
    const b = new AgentBrowserBridge(mockBrowserManager(new Map()))
    await expect(b.snapshot()).rejects.toThrow('No browser tab open')
  })

  // ── Tab close clears active ──

  it('clears activeWebContentsId on tab close', async () => {
    succeedWith({ snapshot: 'tree' })
    await bridge.snapshot()

    await bridge.onTabClosed(100)
    expect(bridge.getActiveWebContentsId()).toBeNull()
  })

  it('closes the named agent-browser session when a tab closes', async () => {
    succeedWith({ snapshot: 'tree' })
    await bridge.snapshot()

    execFileMock.mockClear()
    succeedWith(null)
    await bridge.onTabClosed(100)

    const closeCall = execFileMock.mock.calls.find((call: unknown[]) =>
      (call[1] as string[]).includes('close')
    )
    expect(closeCall).toBeTruthy()
    expect(closeCall![1]).toEqual(['--session', 'orca-tab-tab-1', 'close'])
  })

  it('repairs per-worktree active routing when the active tab closes', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const worktrees = new Map([
      ['tab-a', 'wt-1'],
      ['tab-b', 'wt-1']
    ])
    const wc2 = mockWebContents(2, 'https://b.com', 'B')
    webContentsFromIdMock.mockImplementation((id: number) => (id === 2 ? wc2 : null))

    const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
    b.setActiveTab(1, 'wt-1')

    await b.onTabClosed(1)

    expect(b.getActiveWebContentsId()).toBe(2)
    expect(b.tabList('wt-1').tabs).toMatchObject([{ browserPageId: 'tab-b', active: true }])
  })

  it('repairs per-worktree active routing when an active tab swaps processes', async () => {
    const tabs = new Map([['tab-a', 200]])
    const worktrees = new Map([['tab-a', 'wt-1']])
    const wc = mockWebContents(200, 'https://a.com', 'A')
    webContentsFromIdMock.mockImplementation((id: number) => (id === 200 ? wc : null))

    const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
    b.setActiveTab(100, 'wt-1')

    await b.onProcessSwap('tab-a', 200, 100)

    expect(b.getActiveWebContentsId()).toBe(200)
    expect(b.tabList('wt-1').tabs).toMatchObject([{ browserPageId: 'tab-a', active: true }])
  })

  // ── tabSwitch success ──

  it('switches active tab and returns switched index', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const wc1 = mockWebContents(1)
    const wc2 = mockWebContents(2)
    webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(1)

    const result = await b.tabSwitch(1)
    expect(result).toEqual({ switched: 1, browserPageId: 'tab-b' })
    expect(b.getActiveWebContentsId()).toBe(2)
  })

  it('switches tabs by explicit browser page id', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const wc1 = mockWebContents(1)
    const wc2 = mockWebContents(2)
    webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(1)

    const result = await b.tabSwitch(undefined, undefined, 'tab-b')
    expect(result).toEqual({ switched: 1, browserPageId: 'tab-b' })
    expect(b.getActiveWebContentsId()).toBe(2)
  })

  it('updates the owning worktree active tab when switching by browser page id', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const worktrees = new Map([
      ['tab-a', 'wt-1'],
      ['tab-b', 'wt-1']
    ])
    const wc1 = mockWebContents(1, 'https://a.com', 'A')
    const wc2 = mockWebContents(2, 'https://b.com', 'B')
    webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

    const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
    b.setActiveTab(2, 'wt-1')

    await expect(b.tabSwitch(undefined, undefined, 'tab-a')).resolves.toEqual({
      switched: 0,
      browserPageId: 'tab-a'
    })
    expect(b.tabList('wt-1').tabs).toMatchObject([
      { browserPageId: 'tab-a', active: true },
      { browserPageId: 'tab-b', active: false }
    ])
  })

  it('queues tabSwitch behind in-flight commands on the current session', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const worktrees = new Map([
      ['tab-a', 'wt-1'],
      ['tab-b', 'wt-1']
    ])
    const wc1 = mockWebContents(1)
    const wc2 = mockWebContents(2)
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 1 ? wc1 : id === 2 ? wc2 : null
    )

    const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
    b.setActiveTab(1, 'wt-1')

    let releaseSnapshot: (() => void) | null = null
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        if (args.includes('close')) {
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        if (args.includes('snapshot')) {
          releaseSnapshot = () => {
            cb(null, JSON.stringify({ success: true, data: { snapshot: 'tree' } }), '')
          }
          return
        }
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    const snapshot = b.snapshot('wt-1')
    const switched = b.tabSwitch(1, 'wt-1')

    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(b.getActiveWebContentsId()).toBe(1)
    expect(releaseSnapshot).not.toBeNull()

    releaseSnapshot!()
    await expect(snapshot).resolves.toEqual({ browserPageId: 'tab-a', snapshot: 'tree' })
    await expect(switched).resolves.toEqual({ switched: 1, browserPageId: 'tab-b' })
    expect(b.getActiveWebContentsId()).toBe(2)
  })
})
