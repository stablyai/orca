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
import { runWithActiveRpcCaller } from '../runtime/rpc/rpc-active-caller'
import {
  answerAgentBrowserCommands,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  succeedRecordingAgentBrowserSpawns
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

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

    const spawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, {
      snapshot: 'tree output'
    })
    const result = await b.snapshot(undefined, 'tab-b')

    const snapshotArgs = spawns.find(({ command }) => command[0] === 'snapshot')?.args
    expect(snapshotArgs).toContain('--session')
    expect(snapshotArgs![snapshotArgs!.indexOf('--session') + 1]).toBe('orca-tab-tab-b')
    expect(result).toEqual({ browserPageId: 'tab-b', snapshot: 'tree output' })
    expect(b.getActiveWebContentsId()).toBe(1)
  })

  describe('worktree filtering', () => {
    it.each([null, 'workspace-login'])(
      'lists the matching workspace with profile %s',
      (profileId) => {
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

        const b = new AgentBrowserBridge(
          mockBrowserManager(tabs, worktrees, {
            getSessionProfileIdForTab: vi.fn(() => profileId)
          })
        )
        const result = b.tabList('wt-1')
        expect(result.tabs).toHaveLength(1)
        expect(result.tabs[0].browserPageId).toBe('tab-a')
        expect(result.tabs[0].url).toBe('https://a.com')
        expect(result.tabs[0].profileId).toBe(profileId ?? 'default')
      }
    )

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

  it('throws on out-of-range tab index', async () => {
    await expect(bridge.tabSwitch(99)).rejects.toThrow('Tab index 99 out of range')
  })

  it('throws browser_no_tab when no tabs registered', async () => {
    const b = new AgentBrowserBridge(mockBrowserManager(new Map()))
    await expect(b.snapshot()).rejects.toThrow('No browser tab open')
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

  describe('while an agent drives a tab', () => {
    const agentPages = new Set<string>()
    const agentOnTabA = (): AgentBrowserBridge => {
      const tabs = new Map([
        ['tab-a', 1],
        ['tab-b', 2],
        ['tab-c', 3]
      ])
      const worktrees = new Map([
        ['tab-a', 'wt-1'],
        ['tab-b', 'wt-1'],
        ['tab-c', 'wt-1']
      ])
      const guests = new Map(
        [...tabs].map(([tabId, id]) => [id, mockWebContents(id, `https://${tabId}.com`, tabId)])
      )
      webContentsFromIdMock.mockImplementation((id: number) => guests.get(id) ?? null)
      const b = new AgentBrowserBridge(
        mockBrowserManager(tabs, worktrees, {
          isAgentUsingPage: (id: string) => agentPages.has(id),
          beginAgentCommand: (id: string) => {
            agentPages.add(id)
            return { run: (execute) => execute(), end: () => {} }
          }
        })
      )
      b.onTabChanged(1, 'wt-1')
      agentPages.clear()
      agentPages.add('tab-a')
      return b
    }

    it('keeps unpinned commands on that tab until it goes idle when the user picks another', () => {
      const b = agentOnTabA()

      b.onTabChanged(2, 'wt-1')
      expect(b.getActivePageId('wt-1')).toBe('tab-a')

      agentPages.clear()
      expect(b.getActivePageId('wt-1')).toBe('tab-b')
    })

    it('holds a pick made before the agent switches tabs until the new tab goes idle', async () => {
      const b = agentOnTabA()

      b.onTabChanged(3, 'wt-1')
      await b.tabSwitch(undefined, 'wt-1', 'tab-b')
      expect(b.getActivePageId('wt-1')).toBe('tab-b')

      agentPages.clear()
      expect(b.getActivePageId('wt-1')).toBe('tab-c')
    })

    it.each([
      [{ kind: 'paired-device', deviceId: 'phone' } as const, 'tab-a'],
      [{ kind: 'local-cli' } as const, 'tab-b']
    ])('a tab created by %o routes unpinned commands to %s', (caller, expected) => {
      const b = agentOnTabA()

      runWithActiveRpcCaller(caller, () => b.setActiveTab(2, 'wt-1'))

      expect(b.getActivePageId('wt-1')).toBe(expected)
    })
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

  it('rejects an unpinned ref from another tab snapshot until the current tab is snapshotted', async () => {
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
    webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))
    const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
    b.setActiveTab(1, 'wt-1')
    const clickSessions: string[] = []
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb, args) => {
      if (command[0] === 'click') {
        clickSessions.push(args[args.indexOf('--session') + 1])
      }
      const data = command[0] === 'snapshot' ? { snapshot: '' } : {}
      cb(null, JSON.stringify({ success: true, data }), '')
    })

    await b.snapshot('wt-1')
    await b.tabSwitch(undefined, 'wt-1', 'tab-b')

    await expect(b.click('@e2', 'wt-1')).rejects.toMatchObject({
      code: 'browser_stale_ref',
      message: expect.stringContaining(
        'Run snapshot to get refs for page tab-b, or pass --page tab-a'
      )
    })
    await expect(b.exec('click e2', 'wt-1')).rejects.toMatchObject({ code: 'browser_stale_ref' })
    await b.exec('keyboard type e2', 'wt-1')
    expect(clickSessions).toEqual([])

    await b.click('@e2', undefined, 'tab-a')
    await b.exec('snapshot -i', 'wt-1')
    await b.click('@e2', 'wt-1')
    expect(clickSessions).toEqual(['orca-tab-tab-a', 'orca-tab-tab-b'])
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
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb) => {
      if (command.includes('close')) {
        cb(null, JSON.stringify({ success: true, data: null }), '')
      } else if (command[0] === 'snapshot') {
        releaseSnapshot = () => {
          cb(null, JSON.stringify({ success: true, data: { snapshot: 'tree' } }), '')
        }
      } else {
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    })

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
